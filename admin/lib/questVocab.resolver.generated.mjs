/**
 * GENERATED FILE — DO NOT EDIT BY HAND.
 *
 * The step resolver, re-hydrated. The data below is baked from the real
 * module; the functions below THAT are its own source text, sliced out
 * verbatim, so the admin console rejects exactly what the test suite rejects
 * and says the same words about it.
 *
 * Derived from `scripts/quest-vocab.mjs` by `admin/scripts/gen-quest-vocab.mjs`
 * on 2026-09-01. Regenerate with `npm run vocab` in `admin/`; `npm run build`
 * does it for you. Read the generator's header for why the vocabulary is baked
 * rather than imported, and for the corpus that proves this file agrees with
 * the module it came from.
 */

import {
  WORKING_STEP_TYPES, DEAD_STEP_TYPES, QUEST_WORLDS as QUEST_WORLD_ROWS, STEP_WORLDS as STEP_WORLD_ROWS,
} from './questVocab.lists.generated.mjs';

export { WORKING_STEP_TYPES, DEAD_STEP_TYPES };

/* ── Baked state the sliced functions close over ────────────────────── */

const QUEST_WORLDS = QUEST_WORLD_ROWS.map((w) => w.id);
const STEP_WORLDS = STEP_WORLD_ROWS.map((w) => w.id);
const GATED_STEP_TYPES = [
  "visit"
];
const UNGATED_STEP_TYPES = [
  "collect",
  "talk",
  "interact",
  "kill",
  "defend",
  "race",
  "purchase",
  "customize",
  "survive",
  "mine",
  "pilot",
  "minigame"
];
const QUEST_GATE = {
  "file": "src/systems/QuestSystem.js",
  "clears": [
    "worldQuests"
  ],
  "controlled": [
    "_pending",
    "worldQuests"
  ],
  "gatedMethods": [
    "_creditVisit",
    "_loadQuestsForWorld",
    "_questFromEngagement",
    "_questsOffline",
    "_resolveQuestForEngagement"
  ],
  "gatedTypes": [
    "visit"
  ],
  "evidence": {
    "visit": "_creditVisit"
  }
};
const ROLE = {
  "VENDOR": "vendor",
  "GUARD": "guard",
  "LOITERER": "loiterer",
  "SPECTATOR": "spectator",
  "WANDERER": "wanderer",
  "LOREKEEPER": "lorekeeper",
  "QUEST_MANAGER": "quest_manager"
};
const ROLE_CAST = {
  "station": {
    "vendor": [
      {
        "name": "Quartermaster Bex",
        "persona": "Runs the supply stall on the plaza concourse. Sells ammunition, ration packs and salvage kits, quotes prices before you ask, and grumbles that requisition paperwork moves slower than the freight lifts."
      },
      {
        "name": "Broker Sunil Rai",
        "persona": "A licensed trade broker working a folding stall of surplus. Cheerful, fast-talking, convinced everything is a bargain, and always trying to buy whatever you are carrying."
      }
    ],
    "guard": [
      {
        "name": "Deck Warden Ilse",
        "persona": "Station security posted on the plaza. Watchful and dry-humoured, keeps an eye on the gateway crowds, and will tell you exactly which corridors are off limits this shift."
      },
      {
        "name": "Warden Cato Reyes",
        "persona": "A long-serving deck warden who has seen every kind of trouble come through the gateway. Calm, blunt, quietly proud of a spotless incident record."
      }
    ],
    "spectator": [
      {
        "name": "Observer Nell Yeong",
        "persona": "An off-shift crew member who comes to the plaza to watch the gateway light up. Dreamy, curious about the other worlds, full of half-true stories about travellers."
      }
    ],
    "loiterer": [
      {
        "name": "Dockhand Priya Kaur",
        "persona": "A dockhand killing time between freight calls. Friendly, tired, endlessly opinionated about hull maintenance backlogs and the recycled coffee."
      },
      {
        "name": "Rigger Osei Mensah",
        "persona": "A rigger leaning on a stanchion waiting for a lift crew. Talks shop about the gantries and about a repair nobody has noticed yet."
      }
    ]
  },
  "medieval": {
    "vendor": [
      {
        "name": "Merchant Adela",
        "persona": "Keeps the market stall on the square, selling arrows, provisions and small charms. Shrewd, warm to a paying customer, and full of complaints about the bridge toll."
      },
      {
        "name": "Pedlar Corwin",
        "persona": "A travelling pedlar with a tray of oddments. Talks up every trinket as a relic, buys anything you will part with, and knows a rumour about every road out of the village."
      }
    ],
    "guard": [
      {
        "name": "Watchman Hedric",
        "persona": "A village watchman at his post by the square. Solid, unhurried, suspicious of strangers but honest with them, and certain the keep should send more men."
      },
      {
        "name": "Serjeant Ulla",
        "persona": "A serjeant of the garrison standing watch. Direct and professional, gives clear warnings about the woods after dark."
      }
    ],
    "spectator": [
      {
        "name": "Pilgrim Marda",
        "persona": "A pilgrim resting in the square, convinced the shimmering gate is a sign. Gentle, wide-eyed, asks more questions than she answers."
      }
    ],
    "loiterer": [
      {
        "name": "Goodman Aldous",
        "persona": "A villager in for market day. Quietly proud of his craft, deeply sceptical of anything that glows, and happy to gossip about the keep."
      },
      {
        "name": "Widow Sæwyn",
        "persona": "An old villager who sits out at the square most days. Sharp memory, sharper tongue, and three different versions of every rumour."
      }
    ]
  },
  "sports": {
    "vendor": [
      {
        "name": "Kit Seller Dana Cruz",
        "persona": "Runs the kit and refreshments stand at the park. Upbeat, relentlessly on-message about hydration, and will happily sell you gear you did not know you needed."
      },
      {
        "name": "Pro Shop Marek",
        "persona": "Minds the pro shop counter by the courts. Knows every piece of equipment on the site, buys used gear back, and has firm views about the right grip."
      }
    ],
    "guard": [
      {
        "name": "Steward Alina Bosch",
        "persona": "A site steward keeping the fixtures running. Organised, brisk, always three minutes from the next scheduled match."
      },
      {
        "name": "Marshal Theo Vance",
        "persona": "A course marshal watching the slope. Safety-first, cheerful about it, tells long stories about spectacular crashes."
      }
    ],
    "spectator": [
      {
        "name": "Regular Junie Park",
        "persona": "A park regular watching whatever match is on. Knows every local player, keeps a running commentary, and will explain why your stance is wrong."
      }
    ],
    "loiterer": [
      {
        "name": "Coach Rowan Blake",
        "persona": "A club coach between sessions. Encouraging to a fault, full of drills you did not ask for, and keen to know what sport you play."
      },
      {
        "name": "Skier Ash Delacroix",
        "persona": "A weekend skier waiting for the lift queue to clear. Hyped about the fresh piste and completely unbothered by the cold."
      }
    ]
  },
  "citadel": {
    "vendor": [
      {
        "name": "Sitt Nadira",
        "persona": "Keeps the spice and salt pitch under the gate arch, and has done since the last siege. Quick with a price, quicker with an opinion, and convinced every caravan that comes up the mule road arrives short-weighted."
      },
      {
        "name": "Pedlar Ghassan",
        "persona": "Works a folding tray of oddments along the souk steps. Sells anything, buys anything, and swears on each trinket that it came off the great tower itself."
      }
    ],
    "guard": [
      {
        "name": "Wall-Serjeant Tariq",
        "persona": "Holds the gate watch where the mesa road tops out. Unhurried and courteous, and perfectly clear about which roofs the garrison will pretend not to have seen you on."
      },
      {
        "name": "Watchwoman Sana",
        "persona": "Walks the rampart round between bells. Blunt, observant, and keeps a private tally of everyone who has come off the souk roofs this season."
      }
    ],
    "spectator": [
      {
        "name": "Pilgrim Bahri",
        "persona": "Came up the mule road to watch the sun strike the great tower and is reluctant to discuss anything else. Gentle, dazzled, asks far more than he answers."
      }
    ],
    "loiterer": [
      {
        "name": "Goodman Rashid",
        "persona": "A souk householder taking the shade. Proud of a roof he re-laid himself, deeply sceptical of the archive and everyone in it, and happy to gossip about the falconer."
      },
      {
        "name": "Old Yasmina",
        "persona": "Sits out by the cistern most days. Sharp memory, sharper tongue, and three separate accounts of who the citadel was built against."
      }
    ]
  },
  "maze": {
    "guard": [
      {
        "name": "Hollis Rane",
        "persona": "A self-appointed watcher of a junction he has decided is his to mind, on the theory that someone should keep count of who passes through. Wary of the hedges more than of any person."
      }
    ],
    "spectator": [
      {
        "name": "Merle Ashcombe",
        "persona": "Sits at the same dead end most days, watching the light move through the hedge wall and timing it against a count of her own steps. Not looking for a way out, exactly."
      }
    ],
    "loiterer": [
      {
        "name": "Denna Voss",
        "persona": "Long past the fear stage and into a bored, practical routine - marks junctions, rations food, talks to whoever passes mostly to keep the habit of talking at all."
      },
      {
        "name": "Old Kellen",
        "persona": "Claims to have been in the maze longer than anyone else still walking, and enjoys being doubted about it. Trades directions for company, freely admits both may be wrong."
      }
    ]
  },
  "dock": {
    "vendor": [
      {
        "name": "Storesman Halvard Ek",
        "persona": "Keeps the stores hatch at the end of the chandlery row. Sells consumables and hand tools, buys hull plate and coil by weight without looking up, and can quote the yard stock book from memory. Convinced the trench is where everything that goes missing ends up."
      },
      {
        "name": "Broker Nadia Ferran",
        "persona": "A parts broker working a folding stall between the berths. Fast-talking, cheerful, will buy anything you are carrying and swears every piece of it is going straight onto a hull this week."
      }
    ],
    "guard": [
      {
        "name": "Gate Checker Roan Iveta",
        "persona": "Checks what comes through gateway six and what goes near the blast door. Unarmed, unhurried, and entirely immovable about the rule that nobody stands on the clean strip behind the door."
      },
      {
        "name": "Safety Officer Bram Okoro",
        "persona": "Walks the yard with a clipboard looking for open trench bays and unclipped harnesses. Dry, thorough, and will tell you the exact height above which you are supposed to clip on, which is two metres."
      }
    ],
    "spectator": [
      {
        "name": "Apprentice Sunniva Dahl",
        "persona": "First year in the yard and still stops to watch the crane move. Full of half-right facts about how the hulls came through the gateway in sections, and desperate for somebody to launch something."
      }
    ],
    "loiterer": [
      {
        "name": "Slinger Tobias Marek",
        "persona": "A crane slinger waiting on a lift that has been ten minutes away for an hour. Friendly, bored, endlessly opinionated about which of the four hulls is worth finishing."
      },
      {
        "name": "Plater Zofia Kaminska",
        "persona": "Leaning on a cradle prop with a cold flask, taking the break she is owed. Talks about section joints the way other people talk about weather, and thinks the covered berth should have been uncovered years ago."
      }
    ]
  }
};
const ROLE_ROTATION = [
  "vendor",
  "loiterer",
  "guard",
  "spectator",
  "loiterer",
  "vendor",
  "spectator",
  "loiterer",
  "guard",
  "loiterer",
  "spectator",
  "loiterer"
];
const FILLER_CYCLE = 12;
const CAST_FALLBACK_THEME = "station";
/** Only `Object.keys(ITEMS)` is ever asked of this. */
const ITEMS = {
  "credits": 1,
  "bullet": 1,
  "arrow": 1,
  "fireball_charge": 1,
  "medkit": 1,
  "speed_boost_25": 1,
  "speed_boost_50": 1,
  "speed_boost_75": 1,
  "speed_boost_100": 1,
  "loot_magnet_30s": 1,
  "portal_ping_30s": 1,
  "npc_pause_5s": 1,
  "npc_pause_10s": 1,
  "npc_pause_30s": 1,
  "npc_pause_60s": 1,
  "shield_5s": 1,
  "firepower_boost_25": 1,
  "firepower_boost_50": 1,
  "firepower_boost_75": 1,
  "firepower_boost_100": 1,
  "stamina_draught_25": 1,
  "stamina_draught_50": 1,
  "stamina_draught_75": 1,
  "stamina_draught_100": 1,
  "ward_20": 1,
  "ward_35": 1,
  "ward_50": 1,
  "alloy_scrap": 1,
  "nexus_shard": 1,
  "relic_coin": 1,
  "tephra": 1,
  "sulfur": 1,
  "obsidian": 1,
  "ferrobasalt": 1,
  "rheniite": 1,
  "iridite": 1,
  "regolith": 1,
  "anorthite": 1,
  "sperrylite": 1,
  "helion": 1,
  "silica": 1,
  "halite": 1,
  "selenite": 1,
  "cassiterite": 1,
  "chalcanth": 1,
  "fulgurite": 1,
  "brinesalt": 1,
  "nacre": 1,
  "polymetal": 1,
  "abyssite": 1,
  "rime": 1,
  "clathrate": 1,
  "cryolite": 1,
  "azurine": 1,
  "hyaline": 1,
  "humic": 1,
  "malachite": 1,
  "resin": 1,
  "sporecryst": 1,
  "verdite": 1,
  "ochre": 1,
  "hematite": 1,
  "carnelite": 1,
  "monazite": 1,
  "brimstone": 1,
  "realgar": 1,
  "orpiment": 1,
  "cinnabar": 1,
  "stibnite": 1,
  "quartzite": 1,
  "beryl": 1,
  "spectrolite": 1,
  "lucent": 1,
  "rimefall": 1,
  "sider": 1,
  "tychite": 1,
  "aurichalc": 1,
  "laser_cell": 1,
  "shield_cell": 1,
  "hull_plate": 1,
  "thruster_coil": 1,
  "nav_chart": 1,
  "bag_expand_5": 1,
  "bag_expand_10": 1,
  "bag_expand_15": 1,
  "skin_car_neon": 1,
  "skin_car_inferno": 1,
  "skin_car_phantom": 1,
  "skin_car_toxic": 1,
  "skin_car_azure": 1,
  "skin_dragon_obsidian": 1,
  "skin_dragon_verdant": 1,
  "skin_dragon_frost": 1,
  "skin_eagle_golden": 1,
  "skin_eagle_storm": 1,
  "skin_eagle_ember": 1,
  "skin_horse_midnight": 1,
  "skin_horse_palomino": 1,
  "skin_horse_royal": 1,
  "skin_hover_neon": 1,
  "skin_hover_toxic": 1,
  "skin_hover_solar": 1,
  "skin_bike_chrome": 1,
  "skin_bike_racing": 1,
  "skin_bike_forest": 1,
  "shipskin_kestrel_kingfisher": 1,
  "shipskin_kestrel_blackline": 1,
  "shipskin_kestrel_solstice": 1,
  "shipskin_dray_brasshearth": 1,
  "shipskin_dray_anthracite": 1,
  "shipskin_dray_meridian": 1,
  "shipskin_pike_cinnabar": 1,
  "shipskin_pike_covert": 1,
  "shipskin_pike_whitecap": 1,
  "mountpower_car_power_1": 1,
  "mountpower_car_power_2": 1,
  "mountpower_car_power_3": 1,
  "mountpower_car_strength_1": 1,
  "mountpower_car_strength_2": 1,
  "mountpower_car_strength_3": 1,
  "mountpower_car_shield_1": 1,
  "mountpower_car_shield_2": 1,
  "mountpower_car_shield_3": 1,
  "mountpower_dragon_power_1": 1,
  "mountpower_dragon_power_2": 1,
  "mountpower_dragon_power_3": 1,
  "mountpower_dragon_strength_1": 1,
  "mountpower_dragon_strength_2": 1,
  "mountpower_dragon_strength_3": 1,
  "mountpower_dragon_shield_1": 1,
  "mountpower_dragon_shield_2": 1,
  "mountpower_dragon_shield_3": 1,
  "mountpower_dragon_fire_1": 1,
  "mountpower_dragon_fire_2": 1,
  "mountpower_dragon_fire_3": 1,
  "mountpower_eagle_power_1": 1,
  "mountpower_eagle_power_2": 1,
  "mountpower_eagle_power_3": 1,
  "mountpower_eagle_strength_1": 1,
  "mountpower_eagle_strength_2": 1,
  "mountpower_eagle_strength_3": 1,
  "mountpower_eagle_shield_1": 1,
  "mountpower_eagle_shield_2": 1,
  "mountpower_eagle_shield_3": 1,
  "mountpower_horse_power_1": 1,
  "mountpower_horse_power_2": 1,
  "mountpower_horse_power_3": 1,
  "mountpower_horse_strength_1": 1,
  "mountpower_horse_strength_2": 1,
  "mountpower_horse_strength_3": 1,
  "mountpower_horse_shield_1": 1,
  "mountpower_horse_shield_2": 1,
  "mountpower_horse_shield_3": 1,
  "mountpower_hoverboard_power_1": 1,
  "mountpower_hoverboard_power_2": 1,
  "mountpower_hoverboard_power_3": 1,
  "mountpower_hoverboard_strength_1": 1,
  "mountpower_hoverboard_strength_2": 1,
  "mountpower_hoverboard_strength_3": 1,
  "mountpower_hoverboard_shield_1": 1,
  "mountpower_hoverboard_shield_2": 1,
  "mountpower_hoverboard_shield_3": 1,
  "mountpower_bicycle_power_1": 1,
  "mountpower_bicycle_power_2": 1,
  "mountpower_bicycle_power_3": 1,
  "mountpower_bicycle_strength_1": 1,
  "mountpower_bicycle_strength_2": 1,
  "mountpower_bicycle_strength_3": 1,
  "mountpower_bicycle_shield_1": 1,
  "mountpower_bicycle_shield_2": 1,
  "mountpower_bicycle_shield_3": 1
};

const WORLD_ROWS = {
  "citadel": {
    "id": "citadel",
    "displayName": "Sunspire Citadel",
    "theme": "citadel",
    "rules": {
      "quests": true
    },
    "collectables": [
      "relic_coin",
      "arrow",
      "nexus_shard",
      "medkit",
      "shield_5s"
    ]
  },
  "dock": {
    "id": "dock",
    "displayName": "Lodestar Yard",
    "theme": "dock",
    "rules": {
      "quests": true
    },
    "collectables": [
      "alloy_scrap",
      "hull_plate",
      "laser_cell",
      "medkit",
      "relic_coin"
    ]
  },
  "maze": {
    "id": "maze",
    "displayName": "The Verdant Coil",
    "theme": "maze",
    "rules": {
      "quests": false
    },
    "collectables": []
  },
  "medieval": {
    "id": "medieval",
    "displayName": "Aldermoor Vale",
    "theme": "medieval",
    "rules": {
      "quests": true
    },
    "collectables": [
      "arrow",
      "bullet",
      "relic_coin",
      "fireball_charge",
      "medkit",
      "nexus_shard",
      "shield_5s"
    ]
  },
  "race": {
    "id": "race",
    "displayName": "Vellum Ridge",
    "theme": "station",
    "rules": {
      "quests": true
    },
    "collectables": [
      "alloy_scrap",
      "nexus_shard",
      "bullet",
      "medkit",
      "relic_coin"
    ]
  },
  "space": {
    "id": "space",
    "displayName": "Open Space",
    "theme": "station",
    "rules": {
      "quests": false
    },
    "collectables": []
  },
  "sports": {
    "id": "sports",
    "displayName": "Meridian Athletic Grounds",
    "theme": "sports",
    "rules": {
      "quests": true
    },
    "collectables": [
      "bullet",
      "arrow",
      "fireball_charge",
      "medkit",
      "alloy_scrap",
      "nexus_shard",
      "relic_coin"
    ]
  },
  "station": {
    "id": "station",
    "displayName": "Aether Nexus Station",
    "theme": "station",
    "rules": {
      "quests": true
    },
    "collectables": [
      "bullet",
      "fireball_charge",
      "arrow",
      "alloy_scrap",
      "medkit",
      "nexus_shard",
      "relic_coin",
      "shield_5s"
    ]
  },
  "cinder": {
    "id": "cinder",
    "displayName": "Cinder",
    "theme": "station",
    "rules": {
      "quests": false
    },
    "collectables": []
  },
  "tessera": {
    "id": "tessera",
    "displayName": "Tessera",
    "theme": "station",
    "rules": {
      "quests": false
    },
    "collectables": []
  },
  "sirocco": {
    "id": "sirocco",
    "displayName": "Sirocco",
    "theme": "station",
    "rules": {
      "quests": false
    },
    "collectables": []
  },
  "shoal": {
    "id": "shoal",
    "displayName": "Shoal",
    "theme": "station",
    "rules": {
      "quests": false
    },
    "collectables": []
  },
  "vitrine": {
    "id": "vitrine",
    "displayName": "Vitrine",
    "theme": "station",
    "rules": {
      "quests": false
    },
    "collectables": []
  },
  "verdigris": {
    "id": "verdigris",
    "displayName": "Verdigris",
    "theme": "station",
    "rules": {
      "quests": false
    },
    "collectables": []
  },
  "lathe": {
    "id": "lathe",
    "displayName": "Lathe",
    "theme": "station",
    "rules": {
      "quests": false
    },
    "collectables": []
  },
  "carnelian": {
    "id": "carnelian",
    "displayName": "Carnelian",
    "theme": "station",
    "rules": {
      "quests": false
    },
    "collectables": []
  },
  "sallow": {
    "id": "sallow",
    "displayName": "Sallow",
    "theme": "station",
    "rules": {
      "quests": false
    },
    "collectables": []
  },
  "cathedra": {
    "id": "cathedra",
    "displayName": "Cathedra",
    "theme": "station",
    "rules": {
      "quests": false
    },
    "collectables": []
  }
};

const RESIDENT_ROWS = {
  "citadel": [
    {
      "name": "Rafiq the Keeper",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/CitadelWorld.js authored cast"
    },
    {
      "name": "Hafsa the Dyer",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/CitadelWorld.js authored cast"
    },
    {
      "name": "Bashir the Ostler",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/CitadelWorld.js authored cast"
    },
    {
      "name": "Yusra the Falconer",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/CitadelWorld.js authored cast"
    },
    {
      "name": "Aldric Storne",
      "role": "quest_manager",
      "questManager": true,
      "source": "src/npc/NPCManager._spawnQuestManagers"
    },
    {
      "name": "Sitt Nadira",
      "role": "vendor",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 0 of 25"
    },
    {
      "name": "Pedlar Ghassan",
      "role": "vendor",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 5 of 25"
    },
    {
      "name": "Wall-Serjeant Tariq",
      "role": "guard",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 2 of 25"
    },
    {
      "name": "Watchwoman Sana",
      "role": "guard",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 8 of 25"
    },
    {
      "name": "Pilgrim Bahri",
      "role": "spectator",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 3 of 25"
    },
    {
      "name": "Goodman Rashid",
      "role": "loiterer",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 1 of 25"
    },
    {
      "name": "Old Yasmina",
      "role": "loiterer",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 4 of 25"
    }
  ],
  "dock": [
    {
      "name": "Yard Warden Teodora Vasa",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/DockWorld.js authored cast"
    },
    {
      "name": "Rig-Chief Odalys Prieto",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/DockWorld.js authored cast"
    },
    {
      "name": "Fitter Casimir Oyelaran",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/DockWorld.js authored cast"
    },
    {
      "name": "Signaller Wren Achebe",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/DockWorld.js authored cast"
    },
    {
      "name": "Dispatcher Selim Bregovic",
      "role": "quest_manager",
      "questManager": true,
      "source": "src/npc/NPCManager._spawnQuestManagers"
    },
    {
      "name": "Storesman Halvard Ek",
      "role": "vendor",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 0 of 24"
    },
    {
      "name": "Broker Nadia Ferran",
      "role": "vendor",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 5 of 24"
    },
    {
      "name": "Gate Checker Roan Iveta",
      "role": "guard",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 2 of 24"
    },
    {
      "name": "Safety Officer Bram Okoro",
      "role": "guard",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 8 of 24"
    },
    {
      "name": "Apprentice Sunniva Dahl",
      "role": "spectator",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 3 of 24"
    },
    {
      "name": "Slinger Tobias Marek",
      "role": "loiterer",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 1 of 24"
    },
    {
      "name": "Plater Zofia Kaminska",
      "role": "loiterer",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 4 of 24"
    }
  ],
  "maze": [
    {
      "name": "Corvin Ashe",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Marta Wren",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Ossian Drell",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Pip",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Rue Calder",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Isolde Farr",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Bram Otts",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Ansel the Still",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Thea Vance",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Old Harrow",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Sable",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Fen Marlow",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Juno Pike",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Callum Reed",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Mother Wren",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Idris Vale",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Bexley",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Tomasz Ferro",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Silla",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    },
    {
      "name": "Dorran Ash",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MazeWorld.js authored cast"
    }
  ],
  "medieval": [
    {
      "name": "Bram Tallow",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/MedievalWorld.js authored cast"
    },
    {
      "name": "Wilda Sorrel",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/MedievalWorld.js authored cast"
    },
    {
      "name": "Aveline Pyke",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/MedievalWorld.js authored cast"
    },
    {
      "name": "Captain Osric Vane",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MedievalWorld.js authored cast"
    },
    {
      "name": "Piety Lark",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MedievalWorld.js authored cast"
    },
    {
      "name": "Nell Harrow",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MedievalWorld.js authored cast"
    },
    {
      "name": "Corvin Ash",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MedievalWorld.js authored cast"
    },
    {
      "name": "Goodman Alder",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MedievalWorld.js authored cast"
    },
    {
      "name": "Tibb Marrow",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MedievalWorld.js authored cast"
    },
    {
      "name": "Rook Danby",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MedievalWorld.js authored cast"
    },
    {
      "name": "Serjeant Hale",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MedievalWorld.js authored cast"
    },
    {
      "name": "Watchman Pell",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MedievalWorld.js authored cast"
    },
    {
      "name": "Sister Meriet",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/MedievalWorld.js authored cast"
    },
    {
      "name": "Edmund Marsh",
      "role": "quest_manager",
      "questManager": true,
      "source": "src/npc/NPCManager._spawnQuestManagers"
    }
  ],
  "race": [
    {
      "name": "Marek Vaisey",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/RaceWorld.js authored cast"
    },
    {
      "name": "Ines Okonjo",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/RaceWorld.js authored cast"
    },
    {
      "name": "Devrim Aslan",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/RaceWorld.js authored cast"
    },
    {
      "name": "Halla Brandt",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/RaceWorld.js authored cast"
    },
    {
      "name": "Petra Halvorsen",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/RaceWorld.js authored cast"
    },
    {
      "name": "Tobias Renn",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/RaceWorld.js authored cast"
    },
    {
      "name": "Kai Torres",
      "role": "quest_manager",
      "questManager": true,
      "source": "src/npc/NPCManager._spawnQuestManagers"
    },
    {
      "name": "Quartermaster Bex",
      "role": "vendor",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 0 of 23"
    },
    {
      "name": "Broker Sunil Rai",
      "role": "vendor",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 5 of 23"
    },
    {
      "name": "Deck Warden Ilse",
      "role": "guard",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 2 of 23"
    },
    {
      "name": "Warden Cato Reyes",
      "role": "guard",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 8 of 23"
    },
    {
      "name": "Observer Nell Yeong",
      "role": "spectator",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 3 of 23"
    },
    {
      "name": "Dockhand Priya Kaur",
      "role": "loiterer",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 1 of 23"
    },
    {
      "name": "Rigger Osei Mensah",
      "role": "loiterer",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 4 of 23"
    }
  ],
  "space": [],
  "sports": [
    {
      "name": "Marisol \"Ripgrind\" Vance",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/SportsWorld.js authored cast"
    },
    {
      "name": "Kjell Nordvik",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/SportsWorld.js authored cast"
    },
    {
      "name": "Deborah Quint-Halloway",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/SportsWorld.js authored cast"
    },
    {
      "name": "Tavius Okonkwo",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/SportsWorld.js authored cast"
    },
    {
      "name": "Bernard \"Bernie\" Ashgrove",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/SportsWorld.js authored cast"
    },
    {
      "name": "Odile Fenner",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/SportsWorld.js authored cast"
    },
    {
      "name": "Priya Raghunathan",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/SportsWorld.js authored cast"
    },
    {
      "name": "Petra Vance",
      "role": "quest_manager",
      "questManager": true,
      "source": "src/npc/NPCManager._spawnQuestManagers"
    },
    {
      "name": "Kit Seller Dana Cruz",
      "role": "vendor",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 0 of 22"
    },
    {
      "name": "Pro Shop Marek",
      "role": "vendor",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 5 of 22"
    },
    {
      "name": "Steward Alina Bosch",
      "role": "guard",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 2 of 22"
    },
    {
      "name": "Marshal Theo Vance",
      "role": "guard",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 8 of 22"
    },
    {
      "name": "Regular Junie Park",
      "role": "spectator",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 3 of 22"
    },
    {
      "name": "Coach Rowan Blake",
      "role": "loiterer",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 1 of 22"
    },
    {
      "name": "Skier Ash Delacroix",
      "role": "loiterer",
      "questManager": false,
      "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 4 of 22"
    }
  ],
  "station": [
    {
      "name": "Ceri Bardo",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Osman Reyes",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Bex Corrado",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Marta Vale",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Lt. Idris Fane",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Oyo Tannen",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Sparrow Nkemdi",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Wen Halloway",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Prue Okonkwo",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Dr Ilse Varga",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Tobi Renner",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Anselm Kade",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Nia Sorrel",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Hask Merrow",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Ivo Selk",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Nell Abioye",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Rooke Ilesanmi",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Dispatcher Ovie Kanu",
      "role": "quest_manager",
      "questManager": true,
      "source": "src/worlds/StationWorld.js authored cast"
    },
    {
      "name": "Ovid Casserly",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/station/zones/Canteen.js authored cast"
    },
    {
      "name": "Ma Tsering",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Canteen.js authored cast"
    },
    {
      "name": "Sedna Ilkay",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/station/zones/Canteen.js authored cast"
    },
    {
      "name": "Purser Oleander Vance",
      "role": "quest_manager",
      "questManager": true,
      "source": "src/worlds/station/zones/Canteen.js authored cast"
    },
    {
      "name": "Hallam Oduya",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Canteen.js authored cast"
    },
    {
      "name": "Kesi Aliyeva",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Canteen.js authored cast"
    },
    {
      "name": "Dov Aleksy",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Construction.js authored cast"
    },
    {
      "name": "Yeva Strand",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Construction.js authored cast"
    },
    {
      "name": "Storeman Bardhi Reka",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/station/zones/Construction.js authored cast"
    },
    {
      "name": "Planner Imke Solberg",
      "role": "quest_manager",
      "questManager": true,
      "source": "src/worlds/station/zones/Construction.js authored cast"
    },
    {
      "name": "Ott Vasilyev",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Construction.js authored cast"
    },
    {
      "name": "Safety Officer Chidi Nwosu",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Construction.js authored cast"
    },
    {
      "name": "Coach Ivo Karrass",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Gym.js authored cast"
    },
    {
      "name": "Rue Sandoval",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Gym.js authored cast"
    },
    {
      "name": "Wren Ashimolowo",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/station/zones/Gym.js authored cast"
    },
    {
      "name": "Meret Duhamel",
      "role": "quest_manager",
      "questManager": true,
      "source": "src/worlds/station/zones/Gym.js authored cast"
    },
    {
      "name": "Tarek Bilal",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Gym.js authored cast"
    },
    {
      "name": "Josipa Vrel",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Gym.js authored cast"
    },
    {
      "name": "Yara Bess",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Habitation.js authored cast"
    },
    {
      "name": "Petr Oyelaran",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Habitation.js authored cast"
    },
    {
      "name": "Anneke Fell",
      "role": "vendor",
      "questManager": false,
      "source": "src/worlds/station/zones/Habitation.js authored cast"
    },
    {
      "name": "Officer Doriane Kest",
      "role": "quest_manager",
      "questManager": true,
      "source": "src/worlds/station/zones/Habitation.js authored cast"
    },
    {
      "name": "Sabine Roque",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Habitation.js authored cast"
    },
    {
      "name": "Elian Mabuza",
      "role": "wanderer",
      "questManager": false,
      "source": "src/worlds/station/zones/Habitation.js authored cast"
    },
    {
      "name": "Zara Vex",
      "role": "quest_manager",
      "questManager": true,
      "source": "src/npc/NPCManager._spawnQuestManagers"
    }
  ],
  "cinder": [],
  "tessera": [],
  "sirocco": [],
  "shoal": [],
  "vitrine": [],
  "verdigris": [],
  "lathe": [],
  "carnelian": [],
  "sallow": [],
  "cathedra": []
};

const SPAWN_PLAN_ROWS = {
  "citadel": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 4,
    "authoredCap": 4,
    "authoredSpawned": 4,
    "authoredDropped": 0,
    "lorekeepers": 1,
    "fillerSlots": 25,
    "bodies": 41,
    "overCeiling": false
  },
  "dock": {
    "friendlyBudget": 30,
    "maxHostiles": 0,
    "authored": 4,
    "authoredCap": 4,
    "authoredSpawned": 4,
    "authoredDropped": 0,
    "lorekeepers": 2,
    "fillerSlots": 24,
    "bodies": 31,
    "overCeiling": false
  },
  "maze": {
    "friendlyBudget": 30,
    "maxHostiles": 0,
    "authored": 20,
    "authoredCap": 20,
    "authoredSpawned": 20,
    "authoredDropped": 0,
    "lorekeepers": 0,
    "fillerSlots": 0,
    "bodies": 20,
    "overCeiling": false
  },
  "medieval": {
    "friendlyBudget": 22,
    "maxHostiles": 10,
    "authored": 13,
    "authoredCap": 13,
    "authoredSpawned": 13,
    "authoredDropped": 0,
    "lorekeepers": 1,
    "fillerSlots": 8,
    "bodies": 33,
    "overCeiling": false
  },
  "race": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 6,
    "authoredCap": 6,
    "authoredSpawned": 6,
    "authoredDropped": 0,
    "lorekeepers": 1,
    "fillerSlots": 23,
    "bodies": 41,
    "overCeiling": false
  },
  "space": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 0,
    "authoredCap": 0,
    "authoredSpawned": 0,
    "authoredDropped": 0,
    "lorekeepers": 0,
    "fillerSlots": 0,
    "bodies": 10,
    "overCeiling": false
  },
  "sports": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 7,
    "authoredCap": 7,
    "authoredSpawned": 7,
    "authoredDropped": 0,
    "lorekeepers": 1,
    "fillerSlots": 22,
    "bodies": 41,
    "overCeiling": false
  },
  "station": {
    "friendlyBudget": 50,
    "maxHostiles": 18,
    "authored": 42,
    "authoredCap": 42,
    "authoredSpawned": 42,
    "authoredDropped": 0,
    "lorekeepers": 6,
    "fillerSlots": 2,
    "bodies": 69,
    "overCeiling": false
  },
  "cinder": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 0,
    "authoredCap": 0,
    "authoredSpawned": 0,
    "authoredDropped": 0,
    "lorekeepers": 0,
    "fillerSlots": 0,
    "bodies": 10,
    "overCeiling": false
  },
  "tessera": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 0,
    "authoredCap": 0,
    "authoredSpawned": 0,
    "authoredDropped": 0,
    "lorekeepers": 0,
    "fillerSlots": 0,
    "bodies": 10,
    "overCeiling": false
  },
  "sirocco": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 0,
    "authoredCap": 0,
    "authoredSpawned": 0,
    "authoredDropped": 0,
    "lorekeepers": 0,
    "fillerSlots": 0,
    "bodies": 10,
    "overCeiling": false
  },
  "shoal": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 0,
    "authoredCap": 0,
    "authoredSpawned": 0,
    "authoredDropped": 0,
    "lorekeepers": 0,
    "fillerSlots": 0,
    "bodies": 10,
    "overCeiling": false
  },
  "vitrine": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 0,
    "authoredCap": 0,
    "authoredSpawned": 0,
    "authoredDropped": 0,
    "lorekeepers": 0,
    "fillerSlots": 0,
    "bodies": 10,
    "overCeiling": false
  },
  "verdigris": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 0,
    "authoredCap": 0,
    "authoredSpawned": 0,
    "authoredDropped": 0,
    "lorekeepers": 0,
    "fillerSlots": 0,
    "bodies": 10,
    "overCeiling": false
  },
  "lathe": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 0,
    "authoredCap": 0,
    "authoredSpawned": 0,
    "authoredDropped": 0,
    "lorekeepers": 0,
    "fillerSlots": 0,
    "bodies": 10,
    "overCeiling": false
  },
  "carnelian": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 0,
    "authoredCap": 0,
    "authoredSpawned": 0,
    "authoredDropped": 0,
    "lorekeepers": 0,
    "fillerSlots": 0,
    "bodies": 10,
    "overCeiling": false
  },
  "sallow": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 0,
    "authoredCap": 0,
    "authoredSpawned": 0,
    "authoredDropped": 0,
    "lorekeepers": 0,
    "fillerSlots": 0,
    "bodies": 10,
    "overCeiling": false
  },
  "cathedra": {
    "friendlyBudget": 30,
    "maxHostiles": 10,
    "authored": 0,
    "authoredCap": 0,
    "authoredSpawned": 0,
    "authoredDropped": 0,
    "lorekeepers": 0,
    "fillerSlots": 0,
    "bodies": 10,
    "overCeiling": false
  }
};

const WORLD_ROLE_ROWS = {
  "citadel": [
    "vendor",
    "wanderer",
    "quest_manager",
    "guard",
    "spectator",
    "loiterer",
    "lorekeeper"
  ],
  "dock": [
    "wanderer",
    "quest_manager",
    "vendor",
    "guard",
    "spectator",
    "loiterer",
    "lorekeeper"
  ],
  "maze": [
    "wanderer",
    "lorekeeper"
  ],
  "medieval": [
    "vendor",
    "wanderer",
    "quest_manager",
    "guard",
    "loiterer",
    "lorekeeper"
  ],
  "race": [
    "wanderer",
    "vendor",
    "quest_manager",
    "guard",
    "spectator",
    "loiterer",
    "lorekeeper"
  ],
  "space": [],
  "sports": [
    "wanderer",
    "quest_manager",
    "vendor",
    "guard",
    "spectator",
    "loiterer",
    "lorekeeper"
  ],
  "station": [
    "wanderer",
    "vendor",
    "quest_manager",
    "lorekeeper"
  ],
  "cinder": [],
  "tessera": [],
  "sirocco": [],
  "shoal": [],
  "vitrine": [],
  "verdigris": [],
  "lathe": [],
  "carnelian": [],
  "sallow": [],
  "cathedra": []
};

/** type → world → Candidate[], exactly what `candidatesFor` returned. */
const CANDIDATES = {
  "visit": {
    "citadel": [
      {
        "value": "citadel",
        "kind": "world",
        "source": "src/worlds/CitadelWorld.js static id"
      }
    ],
    "dock": [
      {
        "value": "dock",
        "kind": "world",
        "source": "src/worlds/DockWorld.js static id"
      }
    ],
    "maze": [
      {
        "value": "maze",
        "kind": "world",
        "source": "src/worlds/MazeWorld.js static id"
      }
    ],
    "medieval": [
      {
        "value": "medieval",
        "kind": "world",
        "source": "src/worlds/MedievalWorld.js static id"
      }
    ],
    "race": [
      {
        "value": "race",
        "kind": "world",
        "source": "src/worlds/RaceWorld.js static id"
      }
    ],
    "space": [
      {
        "value": "space",
        "kind": "world",
        "source": "src/worlds/SpaceWorld.js static id"
      }
    ],
    "sports": [
      {
        "value": "sports",
        "kind": "world",
        "source": "src/worlds/SportsWorld.js static id"
      }
    ],
    "station": [
      {
        "value": "station",
        "kind": "world",
        "source": "src/worlds/StationWorld.js static id"
      }
    ],
    "cinder": [
      {
        "value": "cinder",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "tessera": [
      {
        "value": "tessera",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "sirocco": [
      {
        "value": "sirocco",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "shoal": [
      {
        "value": "shoal",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "vitrine": [
      {
        "value": "vitrine",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "verdigris": [
      {
        "value": "verdigris",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "lathe": [
      {
        "value": "lathe",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "carnelian": [
      {
        "value": "carnelian",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "sallow": [
      {
        "value": "sallow",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "cathedra": [
      {
        "value": "cathedra",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ]
  },
  "collect": {
    "citadel": [
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.citadel"
      },
      {
        "value": "arrow",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.citadel"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.citadel"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.citadel"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.citadel"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.citadel"
      },
      {
        "value": "arrow",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.citadel"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.citadel"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('common')"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('rare')"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('rare')"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('rare')"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('prize')"
      },
      {
        "value": "shield_5s",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('prize')"
      }
    ],
    "dock": [
      {
        "value": "alloy_scrap",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.dock"
      },
      {
        "value": "hull_plate",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.dock"
      },
      {
        "value": "laser_cell",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.dock"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.dock"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('common')"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('rare')"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('rare')"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('rare')"
      }
    ],
    "medieval": [
      {
        "value": "arrow",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.medieval"
      },
      {
        "value": "bullet",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.medieval"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.medieval"
      },
      {
        "value": "fireball_charge",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.medieval"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.medieval"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.medieval"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.medieval"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.medieval"
      },
      {
        "value": "arrow",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.medieval"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.medieval"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('common')"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('rare')"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('rare')"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('rare')"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('prize')"
      },
      {
        "value": "shield_5s",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('prize')"
      }
    ],
    "race": [
      {
        "value": "alloy_scrap",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.race"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.race"
      },
      {
        "value": "bullet",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.race"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.race"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('common')"
      }
    ],
    "sports": [
      {
        "value": "bullet",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.sports"
      },
      {
        "value": "arrow",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.sports"
      },
      {
        "value": "fireball_charge",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.sports"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.sports"
      },
      {
        "value": "alloy_scrap",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.sports"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.sports"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.sports"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.sports"
      },
      {
        "value": "alloy_scrap",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.sports"
      },
      {
        "value": "bullet",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.sports"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('common')"
      }
    ],
    "station": [
      {
        "value": "bullet",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.station"
      },
      {
        "value": "fireball_charge",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.station"
      },
      {
        "value": "arrow",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.station"
      },
      {
        "value": "alloy_scrap",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.station"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.station"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/Loot.js DROP_TABLES.station"
      },
      {
        "value": "alloy_scrap",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.station"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.station"
      },
      {
        "value": "bullet",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.station"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Caches.js CACHE_TABLES.station"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('common')"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('prize')"
      },
      {
        "value": "shield_5s",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('prize')"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('rare')"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('rare')"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/Interiors.js _contentsFor('rare')"
      }
    ]
  },
  "talk": {
    "citadel": [
      {
        "value": "Rafiq the Keeper",
        "kind": "npc-name",
        "source": "src/worlds/CitadelWorld.js authored cast"
      },
      {
        "value": "Hafsa the Dyer",
        "kind": "npc-name",
        "source": "src/worlds/CitadelWorld.js authored cast"
      },
      {
        "value": "Bashir the Ostler",
        "kind": "npc-name",
        "source": "src/worlds/CitadelWorld.js authored cast"
      },
      {
        "value": "Yusra the Falconer",
        "kind": "npc-name",
        "source": "src/worlds/CitadelWorld.js authored cast"
      },
      {
        "value": "Sitt Nadira",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 0 of 25"
      },
      {
        "value": "Pedlar Ghassan",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 5 of 25"
      },
      {
        "value": "Wall-Serjeant Tariq",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 2 of 25"
      },
      {
        "value": "Watchwoman Sana",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 8 of 25"
      },
      {
        "value": "Pilgrim Bahri",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 3 of 25"
      },
      {
        "value": "Goodman Rashid",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 1 of 25"
      },
      {
        "value": "Old Yasmina",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.citadel via _populateHubs slot 4 of 25"
      },
      {
        "value": "vendor",
        "kind": "npc-role",
        "source": "carried by an NPC in citadel"
      },
      {
        "value": "wanderer",
        "kind": "npc-role",
        "source": "carried by an NPC in citadel"
      },
      {
        "value": "guard",
        "kind": "npc-role",
        "source": "carried by an NPC in citadel"
      },
      {
        "value": "spectator",
        "kind": "npc-role",
        "source": "carried by an NPC in citadel"
      },
      {
        "value": "loiterer",
        "kind": "npc-role",
        "source": "carried by an NPC in citadel"
      },
      {
        "value": "lorekeeper",
        "kind": "npc-role",
        "source": "carried by an NPC in citadel"
      }
    ],
    "dock": [
      {
        "value": "Yard Warden Teodora Vasa",
        "kind": "npc-name",
        "source": "src/worlds/DockWorld.js authored cast"
      },
      {
        "value": "Rig-Chief Odalys Prieto",
        "kind": "npc-name",
        "source": "src/worlds/DockWorld.js authored cast"
      },
      {
        "value": "Fitter Casimir Oyelaran",
        "kind": "npc-name",
        "source": "src/worlds/DockWorld.js authored cast"
      },
      {
        "value": "Signaller Wren Achebe",
        "kind": "npc-name",
        "source": "src/worlds/DockWorld.js authored cast"
      },
      {
        "value": "Storesman Halvard Ek",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 0 of 24"
      },
      {
        "value": "Broker Nadia Ferran",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 5 of 24"
      },
      {
        "value": "Gate Checker Roan Iveta",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 2 of 24"
      },
      {
        "value": "Safety Officer Bram Okoro",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 8 of 24"
      },
      {
        "value": "Apprentice Sunniva Dahl",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 3 of 24"
      },
      {
        "value": "Slinger Tobias Marek",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 1 of 24"
      },
      {
        "value": "Plater Zofia Kaminska",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.dock via _populateHubs slot 4 of 24"
      },
      {
        "value": "wanderer",
        "kind": "npc-role",
        "source": "carried by an NPC in dock"
      },
      {
        "value": "vendor",
        "kind": "npc-role",
        "source": "carried by an NPC in dock"
      },
      {
        "value": "guard",
        "kind": "npc-role",
        "source": "carried by an NPC in dock"
      },
      {
        "value": "spectator",
        "kind": "npc-role",
        "source": "carried by an NPC in dock"
      },
      {
        "value": "loiterer",
        "kind": "npc-role",
        "source": "carried by an NPC in dock"
      },
      {
        "value": "lorekeeper",
        "kind": "npc-role",
        "source": "carried by an NPC in dock"
      }
    ],
    "maze": [
      {
        "value": "Corvin Ashe",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Marta Wren",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Ossian Drell",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Pip",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Rue Calder",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Isolde Farr",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Bram Otts",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Ansel the Still",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Thea Vance",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Old Harrow",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Sable",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Fen Marlow",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Juno Pike",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Callum Reed",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Mother Wren",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Idris Vale",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Bexley",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Tomasz Ferro",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Silla",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "Dorran Ash",
        "kind": "npc-name",
        "source": "src/worlds/MazeWorld.js authored cast"
      },
      {
        "value": "wanderer",
        "kind": "npc-role",
        "source": "carried by an NPC in maze"
      },
      {
        "value": "lorekeeper",
        "kind": "npc-role",
        "source": "carried by an NPC in maze"
      }
    ],
    "medieval": [
      {
        "value": "Bram Tallow",
        "kind": "npc-name",
        "source": "src/worlds/MedievalWorld.js authored cast"
      },
      {
        "value": "Wilda Sorrel",
        "kind": "npc-name",
        "source": "src/worlds/MedievalWorld.js authored cast"
      },
      {
        "value": "Aveline Pyke",
        "kind": "npc-name",
        "source": "src/worlds/MedievalWorld.js authored cast"
      },
      {
        "value": "Captain Osric Vane",
        "kind": "npc-name",
        "source": "src/worlds/MedievalWorld.js authored cast"
      },
      {
        "value": "Piety Lark",
        "kind": "npc-name",
        "source": "src/worlds/MedievalWorld.js authored cast"
      },
      {
        "value": "Nell Harrow",
        "kind": "npc-name",
        "source": "src/worlds/MedievalWorld.js authored cast"
      },
      {
        "value": "Corvin Ash",
        "kind": "npc-name",
        "source": "src/worlds/MedievalWorld.js authored cast"
      },
      {
        "value": "Goodman Alder",
        "kind": "npc-name",
        "source": "src/worlds/MedievalWorld.js authored cast"
      },
      {
        "value": "Tibb Marrow",
        "kind": "npc-name",
        "source": "src/worlds/MedievalWorld.js authored cast"
      },
      {
        "value": "Rook Danby",
        "kind": "npc-name",
        "source": "src/worlds/MedievalWorld.js authored cast"
      },
      {
        "value": "Serjeant Hale",
        "kind": "npc-name",
        "source": "src/worlds/MedievalWorld.js authored cast"
      },
      {
        "value": "Watchman Pell",
        "kind": "npc-name",
        "source": "src/worlds/MedievalWorld.js authored cast"
      },
      {
        "value": "Sister Meriet",
        "kind": "npc-name",
        "source": "src/worlds/MedievalWorld.js authored cast"
      },
      {
        "value": "vendor",
        "kind": "npc-role",
        "source": "carried by an NPC in medieval"
      },
      {
        "value": "wanderer",
        "kind": "npc-role",
        "source": "carried by an NPC in medieval"
      },
      {
        "value": "guard",
        "kind": "npc-role",
        "source": "carried by an NPC in medieval"
      },
      {
        "value": "loiterer",
        "kind": "npc-role",
        "source": "carried by an NPC in medieval"
      },
      {
        "value": "lorekeeper",
        "kind": "npc-role",
        "source": "carried by an NPC in medieval"
      }
    ],
    "race": [
      {
        "value": "Marek Vaisey",
        "kind": "npc-name",
        "source": "src/worlds/RaceWorld.js authored cast"
      },
      {
        "value": "Ines Okonjo",
        "kind": "npc-name",
        "source": "src/worlds/RaceWorld.js authored cast"
      },
      {
        "value": "Devrim Aslan",
        "kind": "npc-name",
        "source": "src/worlds/RaceWorld.js authored cast"
      },
      {
        "value": "Halla Brandt",
        "kind": "npc-name",
        "source": "src/worlds/RaceWorld.js authored cast"
      },
      {
        "value": "Petra Halvorsen",
        "kind": "npc-name",
        "source": "src/worlds/RaceWorld.js authored cast"
      },
      {
        "value": "Tobias Renn",
        "kind": "npc-name",
        "source": "src/worlds/RaceWorld.js authored cast"
      },
      {
        "value": "Quartermaster Bex",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 0 of 23"
      },
      {
        "value": "Broker Sunil Rai",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 5 of 23"
      },
      {
        "value": "Deck Warden Ilse",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 2 of 23"
      },
      {
        "value": "Warden Cato Reyes",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 8 of 23"
      },
      {
        "value": "Observer Nell Yeong",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 3 of 23"
      },
      {
        "value": "Dockhand Priya Kaur",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 1 of 23"
      },
      {
        "value": "Rigger Osei Mensah",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.station via _populateHubs slot 4 of 23"
      },
      {
        "value": "wanderer",
        "kind": "npc-role",
        "source": "carried by an NPC in race"
      },
      {
        "value": "vendor",
        "kind": "npc-role",
        "source": "carried by an NPC in race"
      },
      {
        "value": "guard",
        "kind": "npc-role",
        "source": "carried by an NPC in race"
      },
      {
        "value": "spectator",
        "kind": "npc-role",
        "source": "carried by an NPC in race"
      },
      {
        "value": "loiterer",
        "kind": "npc-role",
        "source": "carried by an NPC in race"
      },
      {
        "value": "lorekeeper",
        "kind": "npc-role",
        "source": "carried by an NPC in race"
      }
    ],
    "sports": [
      {
        "value": "Marisol \"Ripgrind\" Vance",
        "kind": "npc-name",
        "source": "src/worlds/SportsWorld.js authored cast"
      },
      {
        "value": "Kjell Nordvik",
        "kind": "npc-name",
        "source": "src/worlds/SportsWorld.js authored cast"
      },
      {
        "value": "Deborah Quint-Halloway",
        "kind": "npc-name",
        "source": "src/worlds/SportsWorld.js authored cast"
      },
      {
        "value": "Tavius Okonkwo",
        "kind": "npc-name",
        "source": "src/worlds/SportsWorld.js authored cast"
      },
      {
        "value": "Bernard \"Bernie\" Ashgrove",
        "kind": "npc-name",
        "source": "src/worlds/SportsWorld.js authored cast"
      },
      {
        "value": "Odile Fenner",
        "kind": "npc-name",
        "source": "src/worlds/SportsWorld.js authored cast"
      },
      {
        "value": "Priya Raghunathan",
        "kind": "npc-name",
        "source": "src/worlds/SportsWorld.js authored cast"
      },
      {
        "value": "Kit Seller Dana Cruz",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 0 of 22"
      },
      {
        "value": "Pro Shop Marek",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 5 of 22"
      },
      {
        "value": "Steward Alina Bosch",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 2 of 22"
      },
      {
        "value": "Marshal Theo Vance",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 8 of 22"
      },
      {
        "value": "Regular Junie Park",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 3 of 22"
      },
      {
        "value": "Coach Rowan Blake",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 1 of 22"
      },
      {
        "value": "Skier Ash Delacroix",
        "kind": "npc-name",
        "source": "src/npc/NPCRoles.js ROLE_CAST.sports via _populateHubs slot 4 of 22"
      },
      {
        "value": "wanderer",
        "kind": "npc-role",
        "source": "carried by an NPC in sports"
      },
      {
        "value": "vendor",
        "kind": "npc-role",
        "source": "carried by an NPC in sports"
      },
      {
        "value": "guard",
        "kind": "npc-role",
        "source": "carried by an NPC in sports"
      },
      {
        "value": "spectator",
        "kind": "npc-role",
        "source": "carried by an NPC in sports"
      },
      {
        "value": "loiterer",
        "kind": "npc-role",
        "source": "carried by an NPC in sports"
      },
      {
        "value": "lorekeeper",
        "kind": "npc-role",
        "source": "carried by an NPC in sports"
      }
    ],
    "station": [
      {
        "value": "Ceri Bardo",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Osman Reyes",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Bex Corrado",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Marta Vale",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Lt. Idris Fane",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Oyo Tannen",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Sparrow Nkemdi",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Wen Halloway",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Prue Okonkwo",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Dr Ilse Varga",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Tobi Renner",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Anselm Kade",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Nia Sorrel",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Hask Merrow",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Ivo Selk",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Nell Abioye",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Rooke Ilesanmi",
        "kind": "npc-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Ovid Casserly",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Canteen.js authored cast"
      },
      {
        "value": "Ma Tsering",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Canteen.js authored cast"
      },
      {
        "value": "Sedna Ilkay",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Canteen.js authored cast"
      },
      {
        "value": "Hallam Oduya",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Canteen.js authored cast"
      },
      {
        "value": "Kesi Aliyeva",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Canteen.js authored cast"
      },
      {
        "value": "Dov Aleksy",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Construction.js authored cast"
      },
      {
        "value": "Yeva Strand",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Construction.js authored cast"
      },
      {
        "value": "Storeman Bardhi Reka",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Construction.js authored cast"
      },
      {
        "value": "Ott Vasilyev",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Construction.js authored cast"
      },
      {
        "value": "Safety Officer Chidi Nwosu",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Construction.js authored cast"
      },
      {
        "value": "Coach Ivo Karrass",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Gym.js authored cast"
      },
      {
        "value": "Rue Sandoval",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Gym.js authored cast"
      },
      {
        "value": "Wren Ashimolowo",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Gym.js authored cast"
      },
      {
        "value": "Tarek Bilal",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Gym.js authored cast"
      },
      {
        "value": "Josipa Vrel",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Gym.js authored cast"
      },
      {
        "value": "Yara Bess",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Habitation.js authored cast"
      },
      {
        "value": "Petr Oyelaran",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Habitation.js authored cast"
      },
      {
        "value": "Anneke Fell",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Habitation.js authored cast"
      },
      {
        "value": "Sabine Roque",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Habitation.js authored cast"
      },
      {
        "value": "Elian Mabuza",
        "kind": "npc-name",
        "source": "src/worlds/station/zones/Habitation.js authored cast"
      },
      {
        "value": "wanderer",
        "kind": "npc-role",
        "source": "carried by an NPC in station"
      },
      {
        "value": "vendor",
        "kind": "npc-role",
        "source": "carried by an NPC in station"
      },
      {
        "value": "lorekeeper",
        "kind": "npc-role",
        "source": "carried by an NPC in station"
      }
    ]
  },
  "interact": {
    "citadel": [
      {
        "value": "citadel->station",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "station",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "Aether Nexus Station",
        "kind": "portal-label",
        "source": "src/worlds/StationWorld.js static displayName"
      },
      {
        "value": "Aldric Storne",
        "kind": "quest-manager-name",
        "source": "src/npc/NPCManager._spawnQuestManagers"
      },
      {
        "value": "quest_manager",
        "kind": "npc-role",
        "source": "src/npc/NPCRoles.js ROLE"
      }
    ],
    "dock": [
      {
        "value": "dock->station",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "station",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "Aether Nexus Station",
        "kind": "portal-label",
        "source": "src/worlds/StationWorld.js static displayName"
      },
      {
        "value": "dock->space",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "space",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "Open Space",
        "kind": "portal-label",
        "source": "src/worlds/SpaceWorld.js static displayName"
      },
      {
        "value": "Dispatcher Selim Bregovic",
        "kind": "quest-manager-name",
        "source": "src/npc/NPCManager._spawnQuestManagers"
      },
      {
        "value": "quest_manager",
        "kind": "npc-role",
        "source": "src/npc/NPCRoles.js ROLE"
      }
    ],
    "maze": [
      {
        "value": "maze->station",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "station",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "Aether Nexus Station",
        "kind": "portal-label",
        "source": "src/worlds/StationWorld.js static displayName"
      }
    ],
    "medieval": [
      {
        "value": "medieval->station",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "station",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "Aether Nexus Station",
        "kind": "portal-label",
        "source": "src/worlds/StationWorld.js static displayName"
      },
      {
        "value": "Edmund Marsh",
        "kind": "quest-manager-name",
        "source": "src/npc/NPCManager._spawnQuestManagers"
      },
      {
        "value": "quest_manager",
        "kind": "npc-role",
        "source": "src/npc/NPCRoles.js ROLE"
      }
    ],
    "race": [
      {
        "value": "race->station",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "station",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "Aether Nexus Station",
        "kind": "portal-label",
        "source": "src/worlds/StationWorld.js static displayName"
      },
      {
        "value": "Kai Torres",
        "kind": "quest-manager-name",
        "source": "src/npc/NPCManager._spawnQuestManagers"
      },
      {
        "value": "quest_manager",
        "kind": "npc-role",
        "source": "src/npc/NPCRoles.js ROLE"
      }
    ],
    "space": [
      {
        "value": "space->dock",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "dock",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "Lodestar Yard",
        "kind": "portal-label",
        "source": "src/worlds/DockWorld.js static displayName"
      }
    ],
    "sports": [
      {
        "value": "sports->station",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "station",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "Aether Nexus Station",
        "kind": "portal-label",
        "source": "src/worlds/StationWorld.js static displayName"
      },
      {
        "value": "Petra Vance",
        "kind": "quest-manager-name",
        "source": "src/npc/NPCManager._spawnQuestManagers"
      },
      {
        "value": "quest_manager",
        "kind": "npc-role",
        "source": "src/npc/NPCRoles.js ROLE"
      }
    ],
    "station": [
      {
        "value": "station->race",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "race",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "Vellum Ridge",
        "kind": "portal-label",
        "source": "src/worlds/RaceWorld.js static displayName"
      },
      {
        "value": "station->sports",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "sports",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "Meridian Athletic Grounds",
        "kind": "portal-label",
        "source": "src/worlds/SportsWorld.js static displayName"
      },
      {
        "value": "station->maze",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "maze",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "The Verdant Coil",
        "kind": "portal-label",
        "source": "src/worlds/MazeWorld.js static displayName"
      },
      {
        "value": "station->citadel",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "citadel",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "Sunspire Citadel",
        "kind": "portal-label",
        "source": "src/worlds/CitadelWorld.js static displayName"
      },
      {
        "value": "station->medieval",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "medieval",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "Aldermoor Vale",
        "kind": "portal-label",
        "source": "src/worlds/MedievalWorld.js static displayName"
      },
      {
        "value": "station->dock",
        "kind": "portal-id",
        "source": "src/systems/Portals.js portal.id"
      },
      {
        "value": "dock",
        "kind": "world",
        "source": "src/systems/Portals.js portal:entering to"
      },
      {
        "value": "Lodestar Yard",
        "kind": "portal-label",
        "source": "src/worlds/DockWorld.js static displayName"
      },
      {
        "value": "Dispatcher Ovie Kanu",
        "kind": "quest-manager-name",
        "source": "src/worlds/StationWorld.js authored cast"
      },
      {
        "value": "Purser Oleander Vance",
        "kind": "quest-manager-name",
        "source": "src/worlds/station/zones/Canteen.js authored cast"
      },
      {
        "value": "Planner Imke Solberg",
        "kind": "quest-manager-name",
        "source": "src/worlds/station/zones/Construction.js authored cast"
      },
      {
        "value": "Meret Duhamel",
        "kind": "quest-manager-name",
        "source": "src/worlds/station/zones/Gym.js authored cast"
      },
      {
        "value": "Officer Doriane Kest",
        "kind": "quest-manager-name",
        "source": "src/worlds/station/zones/Habitation.js authored cast"
      },
      {
        "value": "Zara Vex",
        "kind": "quest-manager-name",
        "source": "src/npc/NPCManager._spawnQuestManagers"
      },
      {
        "value": "quest_manager",
        "kind": "npc-role",
        "source": "src/npc/NPCRoles.js ROLE"
      }
    ]
  },
  "kill": {
    "citadel": [
      {
        "value": "sentinel",
        "kind": "hostile-name",
        "source": "src/npc/NPCManager.js:721 fallback name"
      }
    ],
    "medieval": [
      {
        "value": "Bregg Ashfoot",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Dunn Pike",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Fen Marlow",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Hollow Jack",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Marret the Crow",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Old Culley",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Rook Gant",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Sable Ida",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Thessa Bane",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Wry Tam",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      }
    ],
    "sports": [
      {
        "value": "Rogue Security Unit",
        "kind": "hostile-name",
        "source": "sports authored hostiles"
      }
    ],
    "station": [
      {
        "value": "Arc Lance Sentry",
        "kind": "hostile-name",
        "source": "station authored hostiles"
      },
      {
        "value": "Breaker Frame",
        "kind": "hostile-name",
        "source": "station authored hostiles"
      },
      {
        "value": "Rogue Security Unit",
        "kind": "hostile-name",
        "source": "station authored hostiles"
      },
      {
        "value": "Skirmish Drone",
        "kind": "hostile-name",
        "source": "station authored hostiles"
      }
    ]
  },
  "defend": {
    "citadel": [
      {
        "value": "sentinel",
        "kind": "hostile-name",
        "source": "src/npc/NPCManager.js:721 fallback name"
      }
    ],
    "medieval": [
      {
        "value": "Bregg Ashfoot",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Dunn Pike",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Fen Marlow",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Hollow Jack",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Marret the Crow",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Old Culley",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Rook Gant",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Sable Ida",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Thessa Bane",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      },
      {
        "value": "Wry Tam",
        "kind": "hostile-name",
        "source": "medieval authored hostiles"
      }
    ],
    "sports": [
      {
        "value": "Rogue Security Unit",
        "kind": "hostile-name",
        "source": "sports authored hostiles"
      }
    ],
    "station": [
      {
        "value": "Arc Lance Sentry",
        "kind": "hostile-name",
        "source": "station authored hostiles"
      },
      {
        "value": "Breaker Frame",
        "kind": "hostile-name",
        "source": "station authored hostiles"
      },
      {
        "value": "Rogue Security Unit",
        "kind": "hostile-name",
        "source": "station authored hostiles"
      },
      {
        "value": "Skirmish Drone",
        "kind": "hostile-name",
        "source": "station authored hostiles"
      }
    ]
  },
  "race": {
    "race": [
      {
        "value": "vellum",
        "kind": "circuit-id",
        "source": "src/worlds/RaceCircuits.js CIRCUITS"
      },
      {
        "value": "Vellum Ridge Circuit",
        "kind": "circuit-name",
        "source": "src/worlds/RaceCircuits.js CIRCUITS"
      },
      {
        "value": "cinder",
        "kind": "circuit-id",
        "source": "src/worlds/RaceCircuits.js CIRCUITS"
      },
      {
        "value": "Cinder Gorge",
        "kind": "circuit-name",
        "source": "src/worlds/RaceCircuits.js CIRCUITS"
      },
      {
        "value": "aurora",
        "kind": "circuit-id",
        "source": "src/worlds/RaceCircuits.js CIRCUITS"
      },
      {
        "value": "Aurora Rise",
        "kind": "circuit-name",
        "source": "src/worlds/RaceCircuits.js CIRCUITS"
      },
      {
        "value": "car",
        "kind": "race-type",
        "source": "src/race/RaceManager.js RACE_TYPES"
      },
      {
        "value": "dragon",
        "kind": "race-type",
        "source": "src/race/RaceManager.js RACE_TYPES"
      },
      {
        "value": "place_1",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "p1",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "1st",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "first",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "place_2",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "p2",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "2nd",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "second",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "place_3",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "p3",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "3rd",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "third",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "place_4",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "p4",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "4th",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "place_5",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "p5",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "5th",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "place_6",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "p6",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      },
      {
        "value": "6th",
        "kind": "place",
        "source": "QuestSystem._eventTargetCandidates"
      }
    ]
  },
  "purchase": {
    "citadel": [
      {
        "value": "credits",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bullet",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "arrow",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "fireball_charge",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "loot_magnet_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "portal_ping_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_5s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_10s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_60s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shield_5s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_20",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_35",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "alloy_scrap",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "tephra",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sulfur",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "obsidian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ferrobasalt",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rheniite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "iridite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "regolith",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "anorthite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sperrylite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "helion",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "silica",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "halite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "selenite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cassiterite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "chalcanth",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "fulgurite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "brinesalt",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nacre",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "polymetal",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "abyssite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rime",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "clathrate",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cryolite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "azurine",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hyaline",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "humic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "malachite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "resin",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sporecryst",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "verdite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ochre",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hematite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "carnelite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "monazite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "brimstone",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "realgar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "orpiment",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cinnabar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stibnite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "quartzite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "beryl",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "spectrolite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "lucent",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rimefall",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sider",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "tychite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "aurichalc",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "laser_cell",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shield_cell",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hull_plate",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "thruster_coil",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nav_chart",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_5",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_10",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_15",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_neon",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_inferno",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_phantom",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_toxic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_azure",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_obsidian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_verdant",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_frost",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_golden",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_storm",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_ember",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_midnight",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_palomino",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_royal",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_neon",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_toxic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_solar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_chrome",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_racing",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_forest",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_kingfisher",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_blackline",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_solstice",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_brasshearth",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_anthracite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_meridian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_cinnabar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_covert",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_whitecap",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "pack_bullets",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_arrows",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_embers",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_medkit",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_laser_cell",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_nav_chart",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "buy",
        "kind": "trade-kind",
        "source": "src/systems/Marketplace.js market:trade kind"
      },
      {
        "value": "sell",
        "kind": "trade-kind",
        "source": "src/systems/Marketplace.js market:trade kind"
      }
    ],
    "dock": [
      {
        "value": "credits",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bullet",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "arrow",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "fireball_charge",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "loot_magnet_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "portal_ping_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_5s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_10s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_60s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shield_5s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_20",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_35",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "alloy_scrap",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "tephra",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sulfur",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "obsidian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ferrobasalt",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rheniite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "iridite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "regolith",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "anorthite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sperrylite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "helion",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "silica",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "halite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "selenite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cassiterite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "chalcanth",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "fulgurite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "brinesalt",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nacre",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "polymetal",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "abyssite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rime",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "clathrate",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cryolite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "azurine",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hyaline",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "humic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "malachite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "resin",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sporecryst",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "verdite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ochre",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hematite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "carnelite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "monazite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "brimstone",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "realgar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "orpiment",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cinnabar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stibnite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "quartzite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "beryl",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "spectrolite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "lucent",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rimefall",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sider",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "tychite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "aurichalc",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "laser_cell",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shield_cell",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hull_plate",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "thruster_coil",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nav_chart",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_5",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_10",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_15",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_neon",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_inferno",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_phantom",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_toxic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_azure",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_obsidian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_verdant",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_frost",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_golden",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_storm",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_ember",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_midnight",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_palomino",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_royal",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_neon",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_toxic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_solar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_chrome",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_racing",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_forest",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_kingfisher",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_blackline",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_solstice",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_brasshearth",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_anthracite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_meridian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_cinnabar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_covert",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_whitecap",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "pack_bullets",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_arrows",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_embers",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_medkit",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_laser_cell",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_nav_chart",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "buy",
        "kind": "trade-kind",
        "source": "src/systems/Marketplace.js market:trade kind"
      },
      {
        "value": "sell",
        "kind": "trade-kind",
        "source": "src/systems/Marketplace.js market:trade kind"
      }
    ],
    "medieval": [
      {
        "value": "credits",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bullet",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "arrow",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "fireball_charge",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "loot_magnet_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "portal_ping_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_5s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_10s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_60s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shield_5s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_20",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_35",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "alloy_scrap",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "tephra",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sulfur",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "obsidian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ferrobasalt",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rheniite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "iridite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "regolith",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "anorthite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sperrylite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "helion",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "silica",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "halite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "selenite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cassiterite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "chalcanth",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "fulgurite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "brinesalt",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nacre",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "polymetal",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "abyssite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rime",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "clathrate",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cryolite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "azurine",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hyaline",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "humic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "malachite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "resin",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sporecryst",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "verdite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ochre",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hematite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "carnelite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "monazite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "brimstone",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "realgar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "orpiment",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cinnabar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stibnite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "quartzite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "beryl",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "spectrolite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "lucent",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rimefall",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sider",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "tychite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "aurichalc",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "laser_cell",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shield_cell",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hull_plate",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "thruster_coil",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nav_chart",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_5",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_10",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_15",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_neon",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_inferno",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_phantom",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_toxic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_azure",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_obsidian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_verdant",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_frost",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_golden",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_storm",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_ember",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_midnight",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_palomino",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_royal",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_neon",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_toxic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_solar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_chrome",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_racing",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_forest",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_kingfisher",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_blackline",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_solstice",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_brasshearth",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_anthracite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_meridian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_cinnabar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_covert",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_whitecap",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "pack_bullets",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_arrows",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_embers",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_medkit",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_laser_cell",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_nav_chart",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "buy",
        "kind": "trade-kind",
        "source": "src/systems/Marketplace.js market:trade kind"
      },
      {
        "value": "sell",
        "kind": "trade-kind",
        "source": "src/systems/Marketplace.js market:trade kind"
      }
    ],
    "race": [
      {
        "value": "credits",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bullet",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "arrow",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "fireball_charge",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "loot_magnet_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "portal_ping_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_5s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_10s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_60s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shield_5s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_20",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_35",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "alloy_scrap",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "tephra",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sulfur",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "obsidian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ferrobasalt",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rheniite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "iridite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "regolith",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "anorthite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sperrylite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "helion",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "silica",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "halite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "selenite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cassiterite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "chalcanth",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "fulgurite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "brinesalt",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nacre",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "polymetal",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "abyssite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rime",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "clathrate",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cryolite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "azurine",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hyaline",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "humic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "malachite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "resin",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sporecryst",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "verdite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ochre",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hematite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "carnelite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "monazite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "brimstone",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "realgar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "orpiment",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cinnabar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stibnite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "quartzite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "beryl",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "spectrolite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "lucent",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rimefall",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sider",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "tychite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "aurichalc",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "laser_cell",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shield_cell",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hull_plate",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "thruster_coil",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nav_chart",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_5",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_10",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_15",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_neon",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_inferno",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_phantom",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_toxic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_azure",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_obsidian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_verdant",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_frost",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_golden",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_storm",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_ember",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_midnight",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_palomino",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_royal",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_neon",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_toxic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_solar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_chrome",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_racing",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_forest",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_kingfisher",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_blackline",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_solstice",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_brasshearth",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_anthracite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_meridian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_cinnabar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_covert",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_whitecap",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "pack_bullets",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_arrows",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_embers",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_medkit",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_laser_cell",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_nav_chart",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "buy",
        "kind": "trade-kind",
        "source": "src/systems/Marketplace.js market:trade kind"
      },
      {
        "value": "sell",
        "kind": "trade-kind",
        "source": "src/systems/Marketplace.js market:trade kind"
      }
    ],
    "sports": [
      {
        "value": "credits",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bullet",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "arrow",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "fireball_charge",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "loot_magnet_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "portal_ping_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_5s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_10s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_60s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shield_5s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_20",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_35",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "alloy_scrap",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "tephra",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sulfur",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "obsidian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ferrobasalt",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rheniite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "iridite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "regolith",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "anorthite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sperrylite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "helion",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "silica",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "halite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "selenite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cassiterite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "chalcanth",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "fulgurite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "brinesalt",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nacre",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "polymetal",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "abyssite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rime",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "clathrate",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cryolite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "azurine",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hyaline",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "humic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "malachite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "resin",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sporecryst",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "verdite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ochre",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hematite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "carnelite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "monazite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "brimstone",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "realgar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "orpiment",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cinnabar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stibnite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "quartzite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "beryl",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "spectrolite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "lucent",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rimefall",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sider",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "tychite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "aurichalc",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "laser_cell",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shield_cell",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hull_plate",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "thruster_coil",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nav_chart",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_5",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_10",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_15",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_neon",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_inferno",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_phantom",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_toxic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_azure",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_obsidian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_verdant",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_frost",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_golden",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_storm",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_ember",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_midnight",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_palomino",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_royal",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_neon",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_toxic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_solar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_chrome",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_racing",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_forest",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_kingfisher",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_blackline",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_solstice",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_brasshearth",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_anthracite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_meridian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_cinnabar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_covert",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_whitecap",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "pack_bullets",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_arrows",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_embers",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_medkit",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_laser_cell",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_nav_chart",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "buy",
        "kind": "trade-kind",
        "source": "src/systems/Marketplace.js market:trade kind"
      },
      {
        "value": "sell",
        "kind": "trade-kind",
        "source": "src/systems/Marketplace.js market:trade kind"
      }
    ],
    "station": [
      {
        "value": "credits",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bullet",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "arrow",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "fireball_charge",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "medkit",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "speed_boost_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "loot_magnet_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "portal_ping_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_5s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_10s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_30s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "npc_pause_60s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shield_5s",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "firepower_boost_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_25",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_75",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stamina_draught_100",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_20",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_35",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ward_50",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "alloy_scrap",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nexus_shard",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "relic_coin",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "tephra",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sulfur",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "obsidian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ferrobasalt",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rheniite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "iridite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "regolith",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "anorthite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sperrylite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "helion",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "silica",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "halite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "selenite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cassiterite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "chalcanth",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "fulgurite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "brinesalt",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nacre",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "polymetal",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "abyssite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rime",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "clathrate",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cryolite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "azurine",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hyaline",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "humic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "malachite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "resin",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sporecryst",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "verdite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "ochre",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hematite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "carnelite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "monazite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "brimstone",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "realgar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "orpiment",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "cinnabar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "stibnite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "quartzite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "beryl",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "spectrolite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "lucent",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "rimefall",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "sider",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "tychite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "aurichalc",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "laser_cell",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shield_cell",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "hull_plate",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "thruster_coil",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "nav_chart",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_5",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_10",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "bag_expand_15",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_neon",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_inferno",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_phantom",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_toxic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_car_azure",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_obsidian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_verdant",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_dragon_frost",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_golden",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_storm",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_eagle_ember",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_midnight",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_palomino",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_horse_royal",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_neon",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_toxic",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_hover_solar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_chrome",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_racing",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "skin_bike_forest",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_kingfisher",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_blackline",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_kestrel_solstice",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_brasshearth",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_anthracite",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_dray_meridian",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_cinnabar",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_covert",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "shipskin_pike_whitecap",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_car_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_dragon_fire_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_eagle_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_horse_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_hoverboard_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_power_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_strength_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_1",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_2",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "mountpower_bicycle_shield_3",
        "kind": "item",
        "source": "src/systems/ItemDefs.js ITEMS"
      },
      {
        "value": "pack_bullets",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_arrows",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_embers",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_medkit",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_laser_cell",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "pack_nav_chart",
        "kind": "pack",
        "source": "src/systems/ItemDefs.js PACKS"
      },
      {
        "value": "buy",
        "kind": "trade-kind",
        "source": "src/systems/Marketplace.js market:trade kind"
      },
      {
        "value": "sell",
        "kind": "trade-kind",
        "source": "src/systems/Marketplace.js market:trade kind"
      }
    ]
  },
  "customize": {
    "citadel": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "dock": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "maze": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "medieval": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "race": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "space": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "sports": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "station": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "cinder": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "tessera": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "sirocco": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "shoal": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "vitrine": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "verdigris": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "lathe": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "carnelian": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "sallow": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ],
    "cathedra": [
      {
        "value": "male",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "female",
        "kind": "character-sex",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "flightsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "jumpsuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tracksuit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "sportskit",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "tunic",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "robe",
        "kind": "character-outfit",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "short",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "crop",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "buzz",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "ponytail",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bun",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "long",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "bald",
        "kind": "character-hairStyle",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "none",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "band",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "cap",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "hood",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "helm",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "turban",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "circlet",
        "kind": "character-headgear",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "slim",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "average",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "heavy",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_0",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_1",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      },
      {
        "value": "build_2",
        "kind": "character-build",
        "source": "src/player/PlayerAvatar.js"
      }
    ]
  },
  "survive": {
    "citadel": [
      {
        "value": "citadel",
        "kind": "world",
        "source": "src/worlds/CitadelWorld.js static id"
      }
    ],
    "dock": [
      {
        "value": "dock",
        "kind": "world",
        "source": "src/worlds/DockWorld.js static id"
      }
    ],
    "maze": [
      {
        "value": "maze",
        "kind": "world",
        "source": "src/worlds/MazeWorld.js static id"
      }
    ],
    "medieval": [
      {
        "value": "medieval",
        "kind": "world",
        "source": "src/worlds/MedievalWorld.js static id"
      }
    ],
    "race": [
      {
        "value": "race",
        "kind": "world",
        "source": "src/worlds/RaceWorld.js static id"
      }
    ],
    "space": [
      {
        "value": "space",
        "kind": "world",
        "source": "src/worlds/SpaceWorld.js static id"
      }
    ],
    "sports": [
      {
        "value": "sports",
        "kind": "world",
        "source": "src/worlds/SportsWorld.js static id"
      }
    ],
    "station": [
      {
        "value": "station",
        "kind": "world",
        "source": "src/worlds/StationWorld.js static id"
      }
    ],
    "cinder": [
      {
        "value": "cinder",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "tessera": [
      {
        "value": "tessera",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "sirocco": [
      {
        "value": "sirocco",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "shoal": [
      {
        "value": "shoal",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "vitrine": [
      {
        "value": "vitrine",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "verdigris": [
      {
        "value": "verdigris",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "lathe": [
      {
        "value": "lathe",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "carnelian": [
      {
        "value": "carnelian",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "sallow": [
      {
        "value": "sallow",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "cathedra": [
      {
        "value": "cathedra",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ]
  },
  "mine": {
    "cinder": [
      {
        "value": "tephra",
        "kind": "mineral",
        "source": "src/worlds/planets/Volcanic.js minerals"
      },
      {
        "value": "Tephra Nodules",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Volcanic.js minerals"
      },
      {
        "value": "sulfur",
        "kind": "mineral",
        "source": "src/worlds/planets/Volcanic.js minerals"
      },
      {
        "value": "Sulfur Crust",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Volcanic.js minerals"
      },
      {
        "value": "obsidian",
        "kind": "mineral",
        "source": "src/worlds/planets/Volcanic.js minerals"
      },
      {
        "value": "Obsidian Glass",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Volcanic.js minerals"
      },
      {
        "value": "ferrobasalt",
        "kind": "mineral",
        "source": "src/worlds/planets/Volcanic.js minerals"
      },
      {
        "value": "Ferro-Basalt",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Volcanic.js minerals"
      },
      {
        "value": "rheniite",
        "kind": "mineral",
        "source": "src/worlds/planets/Volcanic.js minerals"
      },
      {
        "value": "Rheniite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Volcanic.js minerals"
      },
      {
        "value": "iridite",
        "kind": "mineral",
        "source": "src/worlds/planets/Volcanic.js minerals"
      },
      {
        "value": "Iridite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Volcanic.js minerals"
      },
      {
        "value": "cinder",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "tessera": [
      {
        "value": "regolith",
        "kind": "mineral",
        "source": "src/worlds/planets/Tessera.js minerals"
      },
      {
        "value": "Regolith Fines",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Tessera.js minerals"
      },
      {
        "value": "anorthite",
        "kind": "mineral",
        "source": "src/worlds/planets/Tessera.js minerals"
      },
      {
        "value": "Anorthite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Tessera.js minerals"
      },
      {
        "value": "sperrylite",
        "kind": "mineral",
        "source": "src/worlds/planets/Tessera.js minerals"
      },
      {
        "value": "Sperrylite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Tessera.js minerals"
      },
      {
        "value": "helion",
        "kind": "mineral",
        "source": "src/worlds/planets/Tessera.js minerals"
      },
      {
        "value": "Helion Ice",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Tessera.js minerals"
      },
      {
        "value": "tessera",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "sirocco": [
      {
        "value": "silica",
        "kind": "mineral",
        "source": "src/worlds/planets/Sirocco.js minerals"
      },
      {
        "value": "Silica Sand",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Sirocco.js minerals"
      },
      {
        "value": "halite",
        "kind": "mineral",
        "source": "src/worlds/planets/Sirocco.js minerals"
      },
      {
        "value": "Halite Slab",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Sirocco.js minerals"
      },
      {
        "value": "selenite",
        "kind": "mineral",
        "source": "src/worlds/planets/Sirocco.js minerals"
      },
      {
        "value": "Selenite Rose",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Sirocco.js minerals"
      },
      {
        "value": "cassiterite",
        "kind": "mineral",
        "source": "src/worlds/planets/Sirocco.js minerals"
      },
      {
        "value": "Cassiterite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Sirocco.js minerals"
      },
      {
        "value": "chalcanth",
        "kind": "mineral",
        "source": "src/worlds/planets/Sirocco.js minerals"
      },
      {
        "value": "Chalcanthite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Sirocco.js minerals"
      },
      {
        "value": "fulgurite",
        "kind": "mineral",
        "source": "src/worlds/planets/Sirocco.js minerals"
      },
      {
        "value": "Fulgurite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Sirocco.js minerals"
      },
      {
        "value": "sirocco",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "shoal": [
      {
        "value": "brinesalt",
        "kind": "mineral",
        "source": "src/worlds/planets/Shoal.js minerals"
      },
      {
        "value": "Brine Salt",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Shoal.js minerals"
      },
      {
        "value": "nacre",
        "kind": "mineral",
        "source": "src/worlds/planets/Shoal.js minerals"
      },
      {
        "value": "Nacre Plate",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Shoal.js minerals"
      },
      {
        "value": "polymetal",
        "kind": "mineral",
        "source": "src/worlds/planets/Shoal.js minerals"
      },
      {
        "value": "Polymetallic Nodule",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Shoal.js minerals"
      },
      {
        "value": "abyssite",
        "kind": "mineral",
        "source": "src/worlds/planets/Shoal.js minerals"
      },
      {
        "value": "Abyssite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Shoal.js minerals"
      },
      {
        "value": "shoal",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "vitrine": [
      {
        "value": "rime",
        "kind": "mineral",
        "source": "src/worlds/planets/Vitrine.js minerals"
      },
      {
        "value": "Rime Crust",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Vitrine.js minerals"
      },
      {
        "value": "clathrate",
        "kind": "mineral",
        "source": "src/worlds/planets/Vitrine.js minerals"
      },
      {
        "value": "Clathrate Ice",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Vitrine.js minerals"
      },
      {
        "value": "cryolite",
        "kind": "mineral",
        "source": "src/worlds/planets/Vitrine.js minerals"
      },
      {
        "value": "Cryolite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Vitrine.js minerals"
      },
      {
        "value": "azurine",
        "kind": "mineral",
        "source": "src/worlds/planets/Vitrine.js minerals"
      },
      {
        "value": "Azurine",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Vitrine.js minerals"
      },
      {
        "value": "hyaline",
        "kind": "mineral",
        "source": "src/worlds/planets/Vitrine.js minerals"
      },
      {
        "value": "Hyaline",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Vitrine.js minerals"
      },
      {
        "value": "vitrine",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "verdigris": [
      {
        "value": "humic",
        "kind": "mineral",
        "source": "src/worlds/planets/Verdigris.js minerals"
      },
      {
        "value": "Humic Nodules",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Verdigris.js minerals"
      },
      {
        "value": "malachite",
        "kind": "mineral",
        "source": "src/worlds/planets/Verdigris.js minerals"
      },
      {
        "value": "Malachite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Verdigris.js minerals"
      },
      {
        "value": "resin",
        "kind": "mineral",
        "source": "src/worlds/planets/Verdigris.js minerals"
      },
      {
        "value": "Amber Resin",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Verdigris.js minerals"
      },
      {
        "value": "sporecryst",
        "kind": "mineral",
        "source": "src/worlds/planets/Verdigris.js minerals"
      },
      {
        "value": "Spore Crystal",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Verdigris.js minerals"
      },
      {
        "value": "verdite",
        "kind": "mineral",
        "source": "src/worlds/planets/Verdigris.js minerals"
      },
      {
        "value": "Verdite Heartwood",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Verdigris.js minerals"
      },
      {
        "value": "verdigris",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "lathe": [
      {
        "value": "rimefall",
        "kind": "mineral",
        "source": "src/worlds/planets/Lathe.js minerals"
      },
      {
        "value": "Rimefall Ice",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Lathe.js minerals"
      },
      {
        "value": "sider",
        "kind": "mineral",
        "source": "src/worlds/planets/Lathe.js minerals"
      },
      {
        "value": "Siderite Iron",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Lathe.js minerals"
      },
      {
        "value": "tychite",
        "kind": "mineral",
        "source": "src/worlds/planets/Lathe.js minerals"
      },
      {
        "value": "Tychite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Lathe.js minerals"
      },
      {
        "value": "aurichalc",
        "kind": "mineral",
        "source": "src/worlds/planets/Lathe.js minerals"
      },
      {
        "value": "Aurichalc",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Lathe.js minerals"
      },
      {
        "value": "lathe",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "carnelian": [
      {
        "value": "ochre",
        "kind": "mineral",
        "source": "src/worlds/planets/Carnelian.js minerals"
      },
      {
        "value": "Ochre Earth",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Carnelian.js minerals"
      },
      {
        "value": "hematite",
        "kind": "mineral",
        "source": "src/worlds/planets/Carnelian.js minerals"
      },
      {
        "value": "Hematite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Carnelian.js minerals"
      },
      {
        "value": "carnelite",
        "kind": "mineral",
        "source": "src/worlds/planets/Carnelian.js minerals"
      },
      {
        "value": "Carnelite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Carnelian.js minerals"
      },
      {
        "value": "monazite",
        "kind": "mineral",
        "source": "src/worlds/planets/Carnelian.js minerals"
      },
      {
        "value": "Monazite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Carnelian.js minerals"
      },
      {
        "value": "carnelian",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "sallow": [
      {
        "value": "brimstone",
        "kind": "mineral",
        "source": "src/worlds/planets/Sallow.js minerals"
      },
      {
        "value": "Brimstone Crust",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Sallow.js minerals"
      },
      {
        "value": "realgar",
        "kind": "mineral",
        "source": "src/worlds/planets/Sallow.js minerals"
      },
      {
        "value": "Realgar",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Sallow.js minerals"
      },
      {
        "value": "orpiment",
        "kind": "mineral",
        "source": "src/worlds/planets/Sallow.js minerals"
      },
      {
        "value": "Orpiment",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Sallow.js minerals"
      },
      {
        "value": "cinnabar",
        "kind": "mineral",
        "source": "src/worlds/planets/Sallow.js minerals"
      },
      {
        "value": "Cinnabar",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Sallow.js minerals"
      },
      {
        "value": "stibnite",
        "kind": "mineral",
        "source": "src/worlds/planets/Sallow.js minerals"
      },
      {
        "value": "Stibnite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Sallow.js minerals"
      },
      {
        "value": "sallow",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ],
    "cathedra": [
      {
        "value": "quartzite",
        "kind": "mineral",
        "source": "src/worlds/planets/Cathedra.js minerals"
      },
      {
        "value": "Quartzite Gravel",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Cathedra.js minerals"
      },
      {
        "value": "beryl",
        "kind": "mineral",
        "source": "src/worlds/planets/Cathedra.js minerals"
      },
      {
        "value": "Beryl Prisms",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Cathedra.js minerals"
      },
      {
        "value": "spectrolite",
        "kind": "mineral",
        "source": "src/worlds/planets/Cathedra.js minerals"
      },
      {
        "value": "Spectrolite",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Cathedra.js minerals"
      },
      {
        "value": "lucent",
        "kind": "mineral",
        "source": "src/worlds/planets/Cathedra.js minerals"
      },
      {
        "value": "Lucent",
        "kind": "mineral-name",
        "source": "src/worlds/planets/Cathedra.js minerals"
      },
      {
        "value": "cathedra",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      }
    ]
  },
  "pilot": {
    "cinder": [
      {
        "value": "cinder",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      },
      {
        "value": "ashfall",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Volcanic.js landing"
      },
      {
        "value": "Ashfall Flat",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Volcanic.js landing"
      },
      {
        "value": "rimhold",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Volcanic.js landing"
      },
      {
        "value": "Rimhold Shelf",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Volcanic.js landing"
      },
      {
        "value": "colonnade",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Volcanic.js landing"
      },
      {
        "value": "Colonnade Deck",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Volcanic.js landing"
      }
    ],
    "tessera": [
      {
        "value": "tessera",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      },
      {
        "value": "mosaic",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Tessera.js landing"
      },
      {
        "value": "Mosaic Flat",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Tessera.js landing"
      },
      {
        "value": "raysedge",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Tessera.js landing"
      },
      {
        "value": "Raysedge",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Tessera.js landing"
      },
      {
        "value": "coldwell",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Tessera.js landing"
      },
      {
        "value": "The Cold Well",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Tessera.js landing"
      }
    ],
    "sirocco": [
      {
        "value": "sirocco",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      },
      {
        "value": "panhead",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Sirocco.js landing"
      },
      {
        "value": "Pan Head",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Sirocco.js landing"
      },
      {
        "value": "rimwatch",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Sirocco.js landing"
      },
      {
        "value": "Rimwatch",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Sirocco.js landing"
      },
      {
        "value": "windward",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Sirocco.js landing"
      },
      {
        "value": "Windward Stack",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Sirocco.js landing"
      }
    ],
    "shoal": [
      {
        "value": "shoal",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      },
      {
        "value": "glassflat",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Shoal.js landing"
      },
      {
        "value": "Glassflat Deck",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Shoal.js landing"
      },
      {
        "value": "kelphold",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Shoal.js landing"
      },
      {
        "value": "Kelphold",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Shoal.js landing"
      },
      {
        "value": "sunder",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Shoal.js landing"
      },
      {
        "value": "Sunder Deck",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Shoal.js landing"
      }
    ],
    "vitrine": [
      {
        "value": "vitrine",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      },
      {
        "value": "firn",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Vitrine.js landing"
      },
      {
        "value": "Firn Flat",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Vitrine.js landing"
      },
      {
        "value": "blackhorn",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Vitrine.js landing"
      },
      {
        "value": "Blackhorn Bench",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Vitrine.js landing"
      },
      {
        "value": "vaultmouth",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Vitrine.js landing"
      },
      {
        "value": "Vaultmouth",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Vitrine.js landing"
      }
    ],
    "verdigris": [
      {
        "value": "verdigris",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      },
      {
        "value": "greenspan",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Verdigris.js landing"
      },
      {
        "value": "Greenspan Clearing",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Verdigris.js landing"
      },
      {
        "value": "sumphead",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Verdigris.js landing"
      },
      {
        "value": "Sumphead Shelf",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Verdigris.js landing"
      },
      {
        "value": "crown",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Verdigris.js landing"
      },
      {
        "value": "Crown Deck",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Verdigris.js landing"
      }
    ],
    "lathe": [
      {
        "value": "lathe",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      },
      {
        "value": "drifthead",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Lathe.js landing"
      },
      {
        "value": "Drifthead",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Lathe.js landing"
      },
      {
        "value": "shepherd_notch",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Lathe.js landing"
      },
      {
        "value": "Shepherd Notch",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Lathe.js landing"
      },
      {
        "value": "highwall",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Lathe.js landing"
      },
      {
        "value": "Highwall",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Lathe.js landing"
      }
    ],
    "carnelian": [
      {
        "value": "carnelian",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      },
      {
        "value": "redgate",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Carnelian.js landing"
      },
      {
        "value": "Redgate",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Carnelian.js landing"
      },
      {
        "value": "anvil",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Carnelian.js landing"
      },
      {
        "value": "Anvil Deck",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Carnelian.js landing"
      },
      {
        "value": "kiln",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Carnelian.js landing"
      },
      {
        "value": "Kiln Deck",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Carnelian.js landing"
      }
    ],
    "sallow": [
      {
        "value": "sallow",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      },
      {
        "value": "cauldron",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Sallow.js landing"
      },
      {
        "value": "Cauldron Flat",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Sallow.js landing"
      },
      {
        "value": "stillwater",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Sallow.js landing"
      },
      {
        "value": "Stillwater Step",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Sallow.js landing"
      },
      {
        "value": "throat",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Sallow.js landing"
      },
      {
        "value": "The Throat Shelf",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Sallow.js landing"
      }
    ],
    "cathedra": [
      {
        "value": "cathedra",
        "kind": "world",
        "source": "src/worlds/PlanetWorld.js static id"
      },
      {
        "value": "pavement",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Cathedra.js landing"
      },
      {
        "value": "The Pavement",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Cathedra.js landing"
      },
      {
        "value": "gallery",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Cathedra.js landing"
      },
      {
        "value": "The Gallery",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Cathedra.js landing"
      },
      {
        "value": "lantern",
        "kind": "landing-pad",
        "source": "src/worlds/planets/Cathedra.js landing"
      },
      {
        "value": "The Lantern",
        "kind": "landing-pad-name",
        "source": "src/worlds/planets/Cathedra.js landing"
      }
    ]
  },
  "minigame": {
    "citadel": [
      {
        "value": "Souk Rooftop Dash",
        "kind": "minigame-label",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "citadel_souk_dash",
        "kind": "minigame-venue",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "rooftop_trial_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "rooftop_trial_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "The Long Ascent",
        "kind": "minigame-label",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "citadel_ascent",
        "kind": "minigame-venue",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "rooftop_trial_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "rooftop_trial_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "The Skyline",
        "kind": "minigame-label",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "citadel_skyline",
        "kind": "minigame-venue",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "rooftop_trial_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "rooftop_trial_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "The Caravanserai Round",
        "kind": "minigame-label",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "citadel_serai_circuit",
        "kind": "minigame-venue",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "rooftop_trial_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "rooftop_trial_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "The Undercliff Terrace",
        "kind": "minigame-label",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "citadel_undercliff_run",
        "kind": "minigame-venue",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "rooftop_trial_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "rooftop_trial_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "The Deepworks Plunge",
        "kind": "minigame-label",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "citadel_deepworks_plunge",
        "kind": "minigame-venue",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "rooftop_trial_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "rooftop_trial_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "The Long Water",
        "kind": "minigame-label",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "citadel_aqueduct_run",
        "kind": "minigame-venue",
        "source": "src/worlds/CitadelWorld.js minigameVenues"
      },
      {
        "value": "rooftop_trial_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "rooftop_trial_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/CitadelWorld.js minigameVenues + src/minigames/RooftopTrial.js ROOFTOP_GAME_ID"
      },
      {
        "value": "place_1",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      },
      {
        "value": "p1",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      },
      {
        "value": "first",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      }
    ],
    "dock": [
      {
        "value": "The Test-Fire Butts",
        "kind": "minigame-label",
        "source": "src/worlds/DockWorld.js minigameVenues"
      },
      {
        "value": "yard_butts",
        "kind": "minigame-venue",
        "source": "src/worlds/DockWorld.js minigameVenues"
      },
      {
        "value": "test_fire_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/DockWorld.js minigameVenues + src/minigames/TestFire.js TEST_FIRE_GAME_ID"
      },
      {
        "value": "test_fire_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/DockWorld.js minigameVenues + src/minigames/TestFire.js TEST_FIRE_GAME_ID"
      },
      {
        "value": "place_1",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      },
      {
        "value": "p1",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      },
      {
        "value": "first",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      }
    ],
    "race": [
      {
        "value": "The Paddock Parts Round",
        "kind": "minigame-label",
        "source": "src/worlds/RaceWorld.js minigameVenues"
      },
      {
        "value": "vellum_paddock_round",
        "kind": "minigame-venue",
        "source": "src/worlds/RaceWorld.js minigameVenues"
      },
      {
        "value": "delivery_run_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/RaceWorld.js minigameVenues + src/minigames/DeliveryRun.js DELIVERY_GAME_ID"
      },
      {
        "value": "delivery_run_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/RaceWorld.js minigameVenues + src/minigames/DeliveryRun.js DELIVERY_GAME_ID"
      },
      {
        "value": "The Gorge Relay Splice",
        "kind": "minigame-label",
        "source": "src/worlds/RaceWorld.js minigameVenues"
      },
      {
        "value": "gorge_relay_splice",
        "kind": "minigame-venue",
        "source": "src/worlds/RaceWorld.js minigameVenues"
      },
      {
        "value": "drone_hack_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/RaceWorld.js minigameVenues + src/minigames/DroneHack.js HACK_GAME_ID"
      },
      {
        "value": "drone_hack_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/RaceWorld.js minigameVenues + src/minigames/DroneHack.js HACK_GAME_ID"
      },
      {
        "value": "place_1",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      },
      {
        "value": "p1",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      },
      {
        "value": "first",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      }
    ],
    "sports": [
      {
        "value": "Lido Swim Challenge",
        "kind": "minigame-label",
        "source": "src/worlds/SportsWorld.js minigameVenues"
      },
      {
        "value": "lido_pool",
        "kind": "minigame-venue",
        "source": "src/worlds/SportsWorld.js minigameVenues"
      },
      {
        "value": "swim_challenge_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/SportsWorld.js minigameVenues + src/minigames/SwimChallenge.js SWIM_GAME_ID"
      },
      {
        "value": "swim_challenge_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/SportsWorld.js minigameVenues + src/minigames/SwimChallenge.js SWIM_GAME_ID"
      },
      {
        "value": "Meridian Tennis Match",
        "kind": "minigame-label",
        "source": "src/worlds/SportsWorld.js minigameVenues"
      },
      {
        "value": "meridian_court",
        "kind": "minigame-venue",
        "source": "src/worlds/SportsWorld.js minigameVenues"
      },
      {
        "value": "tennis_match_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/SportsWorld.js minigameVenues + src/minigames/TennisMatch.js TENNIS_GAME_ID"
      },
      {
        "value": "tennis_match_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/SportsWorld.js minigameVenues + src/minigames/TennisMatch.js TENNIS_GAME_ID"
      },
      {
        "value": "Meridian Downhill",
        "kind": "minigame-label",
        "source": "src/worlds/SportsWorld.js minigameVenues"
      },
      {
        "value": "meridian_slope",
        "kind": "minigame-venue",
        "source": "src/worlds/SportsWorld.js minigameVenues"
      },
      {
        "value": "ski_slalom_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/SportsWorld.js minigameVenues + src/minigames/SkiRun.js SKI_GAME_ID"
      },
      {
        "value": "ski_slalom_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/SportsWorld.js minigameVenues + src/minigames/SkiRun.js SKI_GAME_ID"
      },
      {
        "value": "Meridian 400 m",
        "kind": "minigame-label",
        "source": "src/worlds/SportsWorld.js minigameVenues"
      },
      {
        "value": "meridian_track",
        "kind": "minigame-venue",
        "source": "src/worlds/SportsWorld.js minigameVenues"
      },
      {
        "value": "track_race_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/SportsWorld.js minigameVenues + src/minigames/TrackRace.js TRACK_GAME_ID"
      },
      {
        "value": "track_race_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/SportsWorld.js minigameVenues + src/minigames/TrackRace.js TRACK_GAME_ID"
      },
      {
        "value": "place_1",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      },
      {
        "value": "p1",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      },
      {
        "value": "first",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      }
    ],
    "station": [
      {
        "value": "The Trunk Relay Splice",
        "kind": "minigame-label",
        "source": "src/worlds/StationWorld.js minigameVenues"
      },
      {
        "value": "station_relay_splice",
        "kind": "minigame-venue",
        "source": "src/worlds/StationWorld.js minigameVenues"
      },
      {
        "value": "drone_hack_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/StationWorld.js minigameVenues + src/minigames/DroneHack.js HACK_GAME_ID"
      },
      {
        "value": "drone_hack_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/StationWorld.js minigameVenues + src/minigames/DroneHack.js HACK_GAME_ID"
      },
      {
        "value": "The Concourse Round",
        "kind": "minigame-label",
        "source": "src/worlds/StationWorld.js minigameVenues"
      },
      {
        "value": "station_concourse_round",
        "kind": "minigame-venue",
        "source": "src/worlds/StationWorld.js minigameVenues"
      },
      {
        "value": "delivery_run_won",
        "kind": "minigame-outcome",
        "source": "src/worlds/StationWorld.js minigameVenues + src/minigames/DeliveryRun.js DELIVERY_GAME_ID"
      },
      {
        "value": "delivery_run_lost",
        "kind": "minigame-outcome",
        "source": "src/worlds/StationWorld.js minigameVenues + src/minigames/DeliveryRun.js DELIVERY_GAME_ID"
      },
      {
        "value": "place_1",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      },
      {
        "value": "p1",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      },
      {
        "value": "first",
        "kind": "minigame-place",
        "source": "QuestSystem._eventTargetCandidates minigame, won === true"
      }
    ]
  }
};

const WORLDS = new Map(Object.entries(WORLD_ROWS));
const RESIDENTS = new Map(Object.entries(RESIDENT_ROWS));
const SPAWN_PLANS = new Map(Object.entries(SPAWN_PLAN_ROWS));
const WORLD_ROLES = new Map(Object.entries(WORLD_ROLE_ROWS));
const VOCAB = { worlds: WORLD_ROWS };

/**
 * The baked stand-in for `candidatesFor`. The real one walks maps built by
 * scraping `src/**`; the table above is what it returned for every (type,
 * world) pair at generation time, so the lookup is the same answer.
 * @param {string} type
 * @param {string|null} worldId
 */
export function candidatesFor(type, worldId = null) {
  if (!worldId) return [];
  return CANDIDATES[type]?.[worldId] ?? [];
}

/* ── Verbatim from scripts/quest-vocab.mjs ──────────────────────────── */

function normalizeTarget(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function tokenRunMatch(a, b) {
  if (!a.length || !b.length) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  for (let i = 0; i + short.length <= long.length; i++) {
    let hit = true;
    for (let j = 0; j < short.length; j++) {
      if (long[i + j] !== short[j]) { hit = false; break; }
    }
    if (hit) return true;
  }
  return false;
}

function targetMatches(target, candidate) {
  const expected = normalizeTarget(target);
  if (!expected) return true;
  const normalized = normalizeTarget(candidate);
  if (!normalized) return false;
  if (normalized === expected) return true;
  return tokenRunMatch(expected.split('_').filter(Boolean), normalized.split('_').filter(Boolean));
}

function fillerSlotFor(role, index) {
  let seen = 0;
  const limit = ROLE_ROTATION.length * (index + 2);
  for (let i = 0; i < limit; i++) {
    if (ROLE_ROTATION[i % ROLE_ROTATION.length] !== role) continue;
    if (seen === index) return i;
    seen++;
  }
  return Infinity;
}

function diagnose(type, raw, world) {
  const notes = [];
  const residents = RESIDENTS.get(world.id) ?? [];

  if (type === 'interact') {
    const hit = residents.find((r) => !r.questManager && targetMatches(raw, r.name));
    if (hit) {
      notes.push(`"${hit.name}" is not a quest manager — HUD.js:1772 emits "talk" for every NPC that is not one, so this step must use type "talk"`);
    }
  }
  if (type === 'talk') {
    const hit = residents.find((r) => r.questManager && targetMatches(raw, r.name));
    if (hit) {
      notes.push(`"${hit.name}" IS a quest manager — HUD.js:1773 emits "interact" and opens the board, so this step must use type "interact"`);
    }
  }

  if (type === 'talk' || type === 'interact') {
    const plan = SPAWN_PLANS.get(world.id);
    const byRole = ROLE_CAST[world.theme] ?? ROLE_CAST[CAST_FALLBACK_THEME] ?? {};
    for (const [role, list] of Object.entries(byRole)) {
      list.forEach((entry, i) => {
        if (!targetMatches(raw, entry.name)) return;
        const slot = fillerSlotFor(role, i);
        notes.push(
          `"${entry.name}" is a ROLE_CAST.${world.theme} name, handed out only by the crowd filler at slot ${slot + 1}`
          + ` — ${world.id} leaves the filler ${plan.fillerSlots} slot(s)`
          + ` (friendlyBudget ${plan.friendlyBudget} − ${plan.authoredSpawned} authored − ${plan.lorekeepers} lorekeeper(s)),`
          + ` and a filler name is only trusted when that residual covers a whole ${FILLER_CYCLE}-slot rotation`,
        );
      });
    }
    const roles = WORLD_ROLES.get(world.id) ?? [];
    for (const role of Object.values(ROLE)) {
      if (roles.includes(role) || !targetMatches(raw, role)) continue;
      notes.push(`no NPC in ${world.id} carries the role "${role}" — it has ${roles.join(', ')}`);
    }
  }

  if (type === 'collect' && Object.keys(ITEMS).some((id) => targetMatches(raw, id))) {
    const w = VOCAB.worlds[world.id];
    notes.push(`no pickup in ${world.id} can contain it — the world yields ${w.collectables.join(', ') || 'nothing'}`);
  }

  // Somewhere else, though? Every world, not just the quest-enabled ones — a
  // step scoped to a quest-less world still advances there.
  const elsewhere = [];
  for (const other of STEP_WORLDS) {
    if (other === world.id) continue;
    if (candidatesFor(type, other).some((c) => targetMatches(raw, c.value))) elsewhere.push(other);
  }
  if (elsewhere.length) {
    notes.push(`it IS reachable in ${elsewhere.join(', ')} — a step only advances in the world it names`);
  }
  return notes.length ? ` (${notes.join('; ')})` : '';
}

function resolveTarget(type, target, opts = {}) {
  const world = opts.world ?? null;
  const t = String(type ?? '').trim();

  if (DEAD_STEP_TYPES.includes(t)) {
    return {
      ok: false,
      reason: 'dead-type',
      detail: `step type "${t}" has no emitter anywhere in src/ — no player action can ever advance it`,
      matched: null,
      candidates: 0,
    };
  }
  if (!WORKING_STEP_TYPES.includes(t)) {
    return {
      ok: false,
      reason: 'unknown-type',
      detail: `step type "${t}" is not one of: ${WORKING_STEP_TYPES.join(', ')}`,
      matched: null,
      candidates: 0,
    };
  }
  if (!world) {
    return {
      ok: false,
      reason: 'no-world',
      detail: 'a step has to name the world it happens in — the vocabulary is per-world, because an NPC that spawns in one world does not spawn in another',
      matched: null,
      candidates: 0,
    };
  }
  if (!WORLDS.has(world)) {
    return {
      ok: false,
      reason: 'unknown-world',
      detail: `world "${world}" is not a registered World.static id (${[...WORLDS.keys()].join(', ')})`,
      matched: null,
      candidates: 0,
    };
  }
  /* `quests: false` gates ACCEPTING and LISTING, not ADVANCING.
   *
   * The gate is one early return in the `world:changed` handler. It empties
   * `worldQuests` — so no board, no accept — but `this.engagements` survives the
   * world change untouched and `_advanceSteps` never consults a world rule. Only
   * the types the gate can actually reach are refused here; the rest are judged
   * on their own emitter and on what the world can produce, exactly as they are
   * anywhere else. See {@link readQuestGate}. */
  if (!WORLDS.get(world).rules.quests && GATED_STEP_TYPES.includes(t)) {
    return {
      ok: false,
      reason: 'quests-disabled',
      detail: `world "${world}" sets quests:false in makeRules, and "${t}" is credited only from `
        + `${QUEST_GATE.evidence[t]}, which sits behind the allows(world, 'quests') early return in `
        + `${QUEST_GATE.file}'s world:changed handler — the handler blanks ${QUEST_GATE.clears.join(', ')} `
        + `and returns before crediting anything. An already-accepted engagement DOES survive the trip, so `
        + `${UNGATED_STEP_TYPES.join(', ')} still advance there; "${t}" cannot.`,
      matched: null,
      candidates: 0,
    };
  }

  const candidates = candidatesFor(t, world);
  const raw = String(target ?? '').trim();

  if (!candidates.length) {
    return {
      ok: false,
      reason: 'no-candidates',
      detail: `nothing in ${world} can emit a "${t}" event`,
      matched: null,
      candidates: 0,
    };
  }

  // The engine treats an empty target as "anything of this type counts".
  if (!raw || !normalizeTarget(raw)) {
    return {
      ok: true,
      reason: null,
      detail: 'untargeted — any event of this type advances it',
      matched: null,
      candidates: candidates.length,
    };
  }

  const hit = candidates.find((c) => targetMatches(raw, c.value));
  if (hit) {
    return {
      ok: true,
      reason: null,
      detail: `matches ${hit.kind} "${hit.value}" (${hit.source})`,
      matched: hit,
      candidates: candidates.length,
    };
  }

  return {
    ok: false,
    reason: 'unknown-target',
    detail: `"${raw}" is not one of the ${candidates.length} ${t} ids reachable in ${world}`
      + diagnose(t, raw, WORLDS.get(world)),
    matched: null,
    candidates: candidates.length,
  };
}

function resolveQuestWorld(worldId) {
  const id = String(worldId ?? '').trim();
  if (!id) {
    return { ok: false, reason: 'quest-world', detail: 'a quest must name the world whose board it stands on' };
  }
  const world = WORLDS.get(id);
  if (!world) {
    return {
      ok: false,
      reason: 'quest-world',
      detail: `"${id}" is not a registered World.static id (${[...WORLDS.keys()].join(', ')})`,
    };
  }
  if (!world.rules.quests) {
    return {
      ok: false,
      reason: 'quest-world',
      detail: `world "${id}" sets quests:false in makeRules — ${QUEST_GATE.file}'s world:changed handler blanks `
        + `${QUEST_GATE.clears.join(', ')} and returns on entry, so this quest never reaches a board and `
        + `accept() could never find it. Steps may be SCOPED to ${id} (${UNGATED_STEP_TYPES.join(', ')} still `
        + `advance there); the quest itself must live on a board in ${QUEST_WORLDS.join(', ')}.`,
    };
  }
  return { ok: true, reason: null, detail: `${id} permits quests, so its board is loaded on entry` };
}

export { normalizeTarget, tokenRunMatch, targetMatches, resolveTarget, resolveQuestWorld };
