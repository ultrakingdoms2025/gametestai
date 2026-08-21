import { CONFIG } from '../core/Config.js';

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
  /**
   * Crowd filling: topping the friendly population up past what the world
   * authors, plus any other NPC the manager adds on its own initiative
   * (lorekeepers derived from portals, hub filler, and the like). Off means
   * the world's own `npcSpawns` is the whole cast, nothing added.
   */
  crowd: true,
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

/**
 * Who owns the `map` key in this world.
 *
 * `M` is contextual by the owner's ruling: the maze's map where mounts are
 * forbidden, the mount wheel everywhere else. The risk in a contextual key is
 * two consumers disagreeing about whose it is - both opening, or neither - so
 * there is ONE predicate and both `MountWheel` and `MazeMap` import it. It
 * cannot disagree with itself.
 *
 * That is also what keeps the key REBINDABLE despite being contextual: a
 * single `map` action in `BINDABLE` carries the code, both consumers read the
 * same bound code, and rebinding moves both together.
 *
 * Defaults to `mounts` for anything without rules, because that is what every
 * world did before the maze existed.
 *
 * @param {{rules?:{mounts?:boolean}}|null|undefined} world
 * @returns {'map'|'mounts'}
 */
export function mapActionOwner(world) {
  return world?.rules?.mounts === false ? 'map' : 'mounts';
}

/**
 * Multipliers on `CONFIG.player.gravity` a world may not go below or above.
 *
 * There is no zero-gravity world yet and this is what would happen if one were
 * authored: `0 / 9.81` is 0, and a ratio of 0 is not floaty, it is BROKEN -
 * the player never falls, so `_grounded` never returns, so the jump, the
 * footsteps, the sprint gate and the landing all stop existing, and
 * `jumpVelocity * 0` means you could not leave the ground to begin with. So
 * the ratio is clamped rather than trusted, to a hundredth of a g at the bottom
 * - a published 0.098 m/s², below Ceres - and four g at the top. At the floor a
 * jump apex is 4.31 m and hangs for 12.50 s, MEASURED, which is absurd but
 * finite, playable and above all NON-DIVERGENT - this project has already lost
 * a day to nineteen NaN pixels blacking out a frame through the bloom pass, and
 * an unbounded `1/r` is exactly how that happens again. A clamp that fires is
 * logged once, naming the world, because a descriptor that reaches it is a typo.
 *
 * They live HERE and not in `Player.js` because the player is no longer the
 * only body that falls. @see worldGravityRatio
 */
export const GRAVITY_RATIO_MIN = 0.01;
export const GRAVITY_RATIO_MAX = 4;

/**
 * Worlds already warned about a clamped ratio, so it is said once and not once
 * per faller. Weak, because a world is a large object and this must not be the
 * reason one outlives its portal.
 * @type {WeakSet<object>}
 */
const _warned = new WeakSet();

/**
 * The surface gravity a world publishes, in m/s², or `null` if it publishes
 * none.
 *
 * ── Why this is a function and not four inline reads ──────────────────────
 * `world.gravity` is ONE fact about a place, and it now has two consumers with
 * completely different integrators behind them: `Piloting._env` hands it to the
 * flight model as a vector, and `Player.setWorldGravity` turns it into the
 * on-foot gravity, the jump velocity and the air-control authority. The failure
 * this exists to make impossible is those two disagreeing about the FACT - a
 * hull settling onto Tessera at a sixth of a g while the pilot who steps out of
 * it walks in the same -22 as the station. That was the shipped state, and it
 * was not a bug in either consumer: it was a number only one of them read.
 *
 * The predicate is deliberately the same one `Piloting._env` already applied -
 * a finite number, nothing else - so that "which worlds have gravity" cannot
 * come out differently on foot than in the cockpit. What each consumer DOES
 * with the number is its own business, and they legitimately differ: the ship
 * uses the raw m/s², the player scales the game's own -22 by it. They agree
 * about the planet; they disagree about nothing.
 *
 * @param {{gravity?:number}|null|undefined} world
 * @returns {number|null} m/s² at the surface, or null for "this world says nothing"
 */
export function worldGravity(world) {
  const g = world?.gravity;
  return typeof g === 'number' && Number.isFinite(g) ? g : null;
}

/**
 * ...and that gravity as a multiple of `CONFIG.player.gravity`, clamped.
 *
 * ── Why this is here and not in `Player.js` ───────────────────────────────
 * It started there, and for one consumer that was right. It has four now - the
 * player's legs, the parkour dive, the mantle's lowest ledge and every NPC that
 * falls - and a ratio computed in four places is four chances to disagree about
 * the same planet. The failure that would produce is the exact one
 * {@link worldGravity} exists to make impossible, one layer up: on Tessera the
 * player would float and the wildlife would plummet, because the ratio only
 * reached one of them. So there is ONE ratio, one clamp and one warning, and
 * every faller in the game divides by the same number.
 *
 * The LAW built on top of it - apex ∝ r^−⅓, hang ∝ r^−⅔, air control ∝ r^⅔ -
 * stays in `Player.js`, which is where it is reasoned about and measured. This
 * function answers only "how heavy is this place", never "what does that do".
 *
 * @param {{gravity?:number, id?:string}|null|undefined} world
 * @returns {number} a finite multiplier in [{@link GRAVITY_RATIO_MIN},
 *   {@link GRAVITY_RATIO_MAX}], and EXACTLY 1 for a world that publishes none
 * @see ../player/Player.js `setWorldGravity`
 */
export function worldGravityRatio(world) {
  const published = worldGravity(world);
  if (published === null) return 1;
  const reference = CONFIG.player.gravityReference;
  /* Belt to the config's braces. `published / 0` is Infinity and
   * `published / NaN` is NaN, and either one reaches a `Math.pow` and then a
   * velocity, and a non-finite velocity is a black frame. */
  const raw = Number.isFinite(reference) && reference > 0 ? published / reference : 1;
  const ratio = raw < GRAVITY_RATIO_MIN ? GRAVITY_RATIO_MIN
    : raw > GRAVITY_RATIO_MAX ? GRAVITY_RATIO_MAX
      : raw;
  if (ratio !== raw && world && typeof world === 'object' && !_warned.has(world)) {
    _warned.add(world);
    console.warn(
      `[WorldRules] world "${world?.id ?? '?'}" publishes gravity ${published} m/s², which is `
      + `${raw.toFixed(4)}x this game's own. Clamped to ${ratio}x - read the note on `
      + 'GRAVITY_RATIO_MIN in WorldRules.js before widening it.'
    );
  }
  return ratio;
}
