/**
 * Per-world capability rules.
 *
 * Until the maze there was no such thing: every system reacted to
 * `world:changed` unconditionally, so any new world got loot, merchants,
 * quests, caches, relics and mounts whether it wanted them or not. The maze
 * wants almost none of it.
 *
 * Enforcement is deliberately dull. Each system keeps its own `world:changed`
 * handler and gains a one-line early return against these flags. A dozen
 * one-line edits are traceable; one clever central interceptor is not, and when
 * it misfires nobody can find out why a trader is standing in a hedge.
 *
 * Everything defaults to permitted, so existing worlds keep behaving exactly as
 * they did without being touched.
 */

/** @type {Readonly<Record<string, boolean>>} */
export const DEFAULT_RULES = Object.freeze({
  /** Weapon selection and the viewmodel. */
  weapons: true,
  /** Summoning any mount. */
  mounts: true,
  /** One-shot ledge mantling. */
  climb: true,
  /** Sustained wall climbing and parkour. */
  parkour: true,
  /** Marketplace traders. */
  merchants: true,
  /** Quest system and quest-manager NPCs. */
  quests: true,
  /** Standing contracts from named NPCs. */
  contracts: true,
  /** Hidden supply caches. */
  caches: true,
  /** Collectible relics. */
  relics: true,
  /** World pickups and drops. */
  loot: true,
  /** Race circuits. */
  races: true,
  /** Enterable building interiors. */
  interiors: true,
  /** Hostile NPC spawns. */
  hostiles: true,
  /** Water volume scanning and swimming. */
  swim: true,
  /**
   * Jumping. Retained in the maze on purpose - disabling climbing does not
   * disable jumping, and the maze's geometry is what makes the hop useless
   * rather than the input being taken away.
   */
  jump: true,
});

/**
 * Build a rule set from the permissive defaults.
 *
 * Throws on an unknown key. A typo (`merchant` for `merchants`) would otherwise
 * permit the very thing it was written to forbid, and would surface months
 * later as inexplicable content in a world that should be empty.
 *
 * @param {Partial<Record<keyof typeof DEFAULT_RULES, boolean>>} [overrides]
 * @returns {Readonly<Record<string, boolean>>}
 */
export function makeRules(overrides = {}) {
  for (const key of Object.keys(overrides)) {
    if (!(key in DEFAULT_RULES)) throw new Error(`unknown world rule: ${key}`);
  }
  return Object.freeze({ ...DEFAULT_RULES, ...overrides });
}

/**
 * Read a capability flag off a world, defaulting to permitted.
 *
 * Systems receive the world in different ways - some from the `world:changed`
 * payload, some by asking the world manager - and some run before any world is
 * active. Missing information must mean "permitted", or a system that
 * initialises early would silently disable itself everywhere.
 *
 * @param {{rules?: Record<string, boolean>}|null|undefined} world
 * @param {keyof typeof DEFAULT_RULES} flag
 * @returns {boolean}
 */
export function allows(world, flag) {
  const rules = world?.rules;
  if (!rules || !(flag in rules)) return true;
  return rules[flag] !== false;
}
