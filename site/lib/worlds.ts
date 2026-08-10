export type WorldId = 'station' | 'medieval' | 'sports' | 'citadel' | 'race' | 'maze';
export type WorldSceneId = WorldId;

export interface WorldDef {
  id: WorldId;
  index: number;        // 1-based
  name: string;         // canonical in-game display name
  role: string;
  kicker: string;
  copy: string;         // marketing line (from game lore)
  fact: string;         // the chip — marketing SoT, NOT prose lore
  accent: string;       // #rrggbb, mirrors station portal colors
  loreScope: string;    // key into /api/lore entries
  scene: WorldSceneId;  // diorama scene id (=== id)
  painterKey: string;   // key into existing site/lib/painters.ts for the static fallback
}

// Names = each world's in-game `static displayName`. Copy paraphrases src/content/Lore.js
// DEFAULT_LORE (maze from src/worlds/MazeWorld.js). Accents mirror StationWorld.js portals.
export const WORLDS: readonly WorldDef[] = [
  { id: 'station',  index: 1, name: 'Aether Nexus Station', role: 'Hub world',       kicker: 'Orbital',
    copy: 'A working habitat hanging before a planet — plaza, market, hydroponics and hangar bays. The archive, the checkpoint.',
    fact: 'The gateway to all six worlds', accent: '#52e9ff', loreScope: 'station', scene: 'station', painterKey: 'station' },
  { id: 'medieval', index: 2, name: 'Aldermoor Vale',       role: 'Exploration world', kicker: 'Open country',
    copy: 'An old-world valley of timber roofs, market squares and castle walls. The water is swimmable and has real depth.',
    fact: 'Walled town · castle · swimmable lakes', accent: '#ffb347', loreScope: 'medieval', scene: 'medieval', painterKey: 'valley' },
  { id: 'sports',   index: 3, name: 'Meridian Athletic Grounds', role: 'Skill world', kicker: 'Floodlit',
    copy: 'A bright training complex of courts, tracks, bowls and snow runs under lights — with a seated crowd watching.',
    fact: 'Pool · courts · skatepark · ski piste', accent: '#2ffb9a', loreScope: 'sports', scene: 'sports', painterKey: 'sports' },
  { id: 'citadel',  index: 4, name: 'Sunspire Citadel',     role: 'Vertical world',    kicker: 'Desert mesa',
    copy: 'A cliff-top town built to be climbed: souk rooftops, rope bridges, minarets and a 46 m great tower.',
    fact: '46 m climbable great tower', accent: '#ffc46b', loreScope: 'citadel', scene: 'citadel', painterKey: 'citadel' },
  { id: 'race',     index: 5, name: 'Vellum Ridge',         role: 'Competition world', kicker: 'Racing',
    copy: 'A 1,599 m lap over rough terrain and through city streets with a real F1 start procedure — three circuits in all.',
    fact: '3 circuits · real F1 start', accent: '#ff5a3c', loreScope: 'race', scene: 'race', painterKey: 'circuit' },
  { id: 'maze',     index: 6, name: 'The Verdant Coil',     role: 'Volatile world',    kicker: 'Hedge maze',
    copy: 'A hedge maze that re-rolls its layout on every single entry. The maze that cannot be learned — that is the entire point.',
    fact: 'Re-generates its layout every visit', accent: '#8fd67a', loreScope: 'maze', scene: 'maze', painterKey: 'maze' },
] as const;
// painterKey maps canonical ids → existing painters.ts keys (medieval→valley, race→circuit).
// 'station/sports/citadel' already match; 'maze' painter is authored later (Task 11).

// Roster counts verified against src/mounts/MountManager.js (6) and src/player/Loadout.js (4).
export const MOUNTS = 6;
export const WEAPONS = 4;

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Hero ticker chips — derived so counts can never be hardcoded out of sync. */
export function heroTicker(): string[] {
  return [`${cap(WORLDS.length)} worlds`, `${cap(MOUNTS)} mounts`, `${cap(WEAPONS)} weapons`,
    'Zero downloads', '100% generated', 'Runs in a tab', 'No install'];
}
/** Stat bar values in [worlds, mounts, weapons, install] order. */
export function statBar(): string[] {
  return [String(WORLDS.length), String(MOUNTS), String(WEAPONS), '0 GB'];
}
export function worldSeq(index: number): string {
  return `${pad2(index)} / ${pad2(WORLDS.length)}`;
}

const WORDS = ['Zero','One','Two','Three','Four','Five','Six','Seven','Eight','Nine'];
function cap(n: number): string { return WORDS[n] ?? String(n); }
