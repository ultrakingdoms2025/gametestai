import { WORLDS, MOUNTS, WEAPONS, type WorldDef, type WorldId } from './worlds';

/* ============================================================================
   The /features page, as data.

   Every list on that page lives here rather than in the JSX so that the
   counts the page shows can be checked against the numbers the rest of the
   site already derives from `worlds.ts` — seven worlds, six mounts, four
   weapons. `features.test.ts` pins those: the Worlds section must name every
   world in WORLDS exactly once, the Mounts list must be MOUNTS long, the
   Weapons list WEAPONS long. A marketing page that quietly disagreed with the
   home page's stat bar would be worse than no page.

   World entries reference a world by id and take their in-game name, accent
   and sequence number from WORLDS at render time — the label ("Medieval") is
   the plain-English one a visitor scans for, the in-game name ("Aldermoor
   Vale") is what they will actually see over the gateway.
   ========================================================================== */

export interface FeatureItem {
  name: string;
  detail?: string;
}

export interface WorldFeature {
  label: string;
  world: WorldId;
  detail: string;
}

interface SectionBase {
  id: string;
  title: string;
  blurb: string;
}

export interface ListSection extends SectionBase {
  kind: 'list';
  items: readonly FeatureItem[];
}

export interface WorldsSection extends SectionBase {
  kind: 'worlds';
  items: readonly WorldFeature[];
}

export type FeatureSection = ListSection | WorldsSection;

/** A world entry joined to its WORLDS row — what the page actually renders. */
export interface ResolvedWorldFeature extends WorldFeature {
  def: WorldDef;
}

export const FEATURE_SECTIONS: readonly FeatureSection[] = [
  {
    id: 'global',
    title: 'Global features',
    kind: 'list',
    blurb: 'What you get everywhere, in every world, from the moment the page loads.',
    items: [
      { name: 'No engine, no download', detail: 'Open a link and you are standing in it. Nothing to install, nothing to patch.' },
      { name: 'Desktop browser', detail: 'Plays in a desktop browser tab with keyboard and mouse.' },
      { name: 'Mobile browser', detail: 'Plays in a mobile browser with on-screen touch controls.' },
      { name: 'Backend admin', detail: 'Audit, lore, quest and marketplace setup from a web dashboard.' },
      { name: 'Character composer', detail: 'Body, build, height, face, skin, hair, headgear and clothing — each chosen independently.' },
      { name: 'Mount composer', detail: 'Skins and per-mount powers for every mount you own.' },
      { name: 'Graphics settings', detail: 'Quality tiers so the game fits the machine in front of it.' },
      { name: 'Sound and music settings', detail: 'Separate control of effects and the per-world score.' },
      { name: 'Statistics tracking', detail: 'Your play, measured and kept.' },
      { name: 'Bug reporting', detail: 'Report a problem from inside the game.' },
      { name: 'Save and load', detail: 'Progress is kept on your account and picked up where you left it.' },
      { name: 'Redefine key bindings', detail: 'Rebind any control to any key.' },
      { name: 'Credits', detail: 'Purchase and earn in-game credits for use in the marketplace.' },
      { name: 'Global and world objectives', detail: 'Goals that span every world, and goals particular to each one.' },
      { name: 'Mini map', detail: 'With zoom in and out.' },
      { name: 'Animations, fall damage and more', detail: 'A body that reacts to what you do to it.' },
      { name: 'Secret key combinations', detail: 'There are some to work out. We are not listing them here.' },
    ],
  },
  {
    id: 'servers',
    title: 'Custom server features',
    kind: 'list',
    blurb: 'Your own server, your own content, played by the people you invite.',
    items: [
      { name: 'Create one or more custom servers' },
      { name: 'Invite and accept friends' },
      { name: 'Create your own lore, marketplace and quest lines' },
      { name: 'In-server chat' },
      { name: 'Person-to-person chat' },
      { name: 'Leaderboards' },
      { name: 'Custom credit tracker', detail: 'Server credits are a separate balance from your main one.' },
    ],
  },
  {
    id: 'worlds',
    title: 'Worlds',
    kind: 'worlds',
    blurb: `${WORLDS.length} worlds to explore, each a gateway away from the station.`,
    items: [
      { label: 'Station', world: 'station',
        detail: 'The main portal hub plus four ancillary habitats, all with buildings to go inside and explore.' },
      { label: 'Medieval', world: 'medieval',
        detail: 'Castles, towns, villages, camps and more — but watch for the bears and the wolf packs hiding in the forests.' },
      { label: 'Citadel', world: 'citadel',
        detail: 'Parkour through the markets, travel to the oasis and the remote diggings, and complete the challenges.' },
      { label: 'Sports', world: 'sports',
        detail: 'Enter the sporting world and take on the mini games: pickleball, swimming, running, skiing.' },
      { label: 'Maze', world: 'maze',
        detail: 'Randomised on every entry. Four levels of maze with hidden tunnels, staircases and challenges to solve — and a view-whole-map option when you need it.' },
      { label: 'Circuit', world: 'race',
        detail: 'Three increasingly complex race circuits — car races, dragon racing and more to discover.' },
      { label: 'Space', world: 'dock',
        detail: 'Explore the hangar and the ships being built, climb inside and launch. Travel through space, fight the invaders, land on six different planet terrains to explore and mine, then launch again and return to the dock.' },
    ],
  },
  {
    id: 'mounts',
    title: 'Mounts',
    kind: 'list',
    blurb: `${MOUNTS} mounts, summoned from a radial wheel on one key. None of them is a reskin.`,
    items: [
      { name: 'Dragon', detail: 'A powered flyer. Climbs when asked, holds altitude, breathes fire.' },
      { name: 'Eagle', detail: 'A glider that trades height for speed.' },
      { name: 'Horse', detail: 'A real gait model — walk, trot, canter, gallop.' },
      { name: 'Hoverboard', detail: 'Nimble. Boosts and carves.' },
      { name: 'Bicycle', detail: 'Honest pedal power.' },
      { name: 'Interceptor', detail: 'The ground car. Built for the circuit and anywhere flat enough to race.' },
    ],
  },
  {
    id: 'weapons',
    title: 'Weapons',
    kind: 'list',
    blurb: `${WEAPONS} weapons. Ammunition comes out of your bag.`,
    items: [
      { name: 'Machine gun' },
      { name: 'Fireballs', detail: 'A charge-and-release ember caster.' },
      { name: 'Bow and arrow', detail: 'A recurve bow with real arrow drop.' },
      { name: 'Sword' },
    ],
  },
  {
    id: 'movement',
    title: 'Movement',
    kind: 'list',
    blurb: 'If it has a face, you can go up it.',
    items: [
      { name: 'Walk' },
      { name: 'Sprint' },
      { name: 'Crawl' },
      { name: 'Climb', detail: 'Grip any near-vertical surface. Stamina is a budget, not a countdown — hang still and you recover.' },
      { name: 'Swim', detail: 'Water with real depth.' },
      { name: 'Roll', detail: 'A landing roll that absorbs a fall that would otherwise hurt.' },
    ],
  },
  {
    id: 'marketplace',
    title: 'Marketplace and inventory',
    kind: 'list',
    blurb: 'Buy, sell, carry and use.',
    items: [
      { name: 'Buy and sell with merchants' },
      { name: 'Unlimited inventory', detail: 'Manage an inventory of unlimited capacity.' },
      { name: 'Active bag', detail: 'Manage the bag of items you actually carry into a fight.' },
      { name: 'Spells, powers and utilities',
        detail: 'Speed, shields, weapon strength, health, and slowing down enemies or opponents.' },
    ],
  },
  {
    id: 'quests',
    title: 'Quests, rewards, challenges and competitions',
    kind: 'list',
    blurb: 'Hundreds of pre-defined quests, with room for your own on a custom server.',
    items: [
      { name: 'Hundreds of pre-defined quests' },
      { name: 'One task or many', detail: 'A quest can be a single task or a chain of them, and may require other quests to be completed first.' },
      { name: 'Per-world and cross-world', detail: 'Quests belong to a world, and quest lines span several.' },
      { name: 'Quest performance tracking' },
    ],
  },
];

/** The Worlds section's entries joined to WORLDS, in the order the page lists them. */
export function worldFeatures(section: WorldsSection): ResolvedWorldFeature[] {
  return section.items.map((w) => {
    const def = WORLDS.find((d) => d.id === w.world);
    if (!def) throw new Error(`features: no world with id "${w.world}"`);
    return { ...w, def };
  });
}

/** Total number of listed items across all sections — the page's headline count. */
export function featureTotal(sections: readonly FeatureSection[] = FEATURE_SECTIONS): number {
  return sections.reduce((n, s) => n + s.items.length, 0);
}
