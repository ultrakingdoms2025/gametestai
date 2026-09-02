/**
 * The quest vocabulary, typed — the ONLY list of step types and worlds the
 * console is allowed to show an operator.
 *
 * ── Why this file is three lines of imports and no data ─────────────────────
 *
 * `StepEditor.tsx` and `quests/page.tsx` each used to hand-list their own copy.
 * The two copies drifted from the engine and from each other, and the drift was
 * not cosmetic:
 *
 *   - the type list offered `deliver`, `escort`, `investigate`, `craft` and
 *     `stealth`, none of which has an emitter anywhere in `src/`, so an
 *     operator could author a quest a player accepts and can never finish;
 *   - it omitted `minigame`, `mine` and `pilot`, which the engine DOES handle
 *     and which shipped quests already use — so opening one of those quests in
 *     the editor and pressing save rewrote its step type to whatever the select
 *     happened to fall back to;
 *   - the world list named five worlds and omitted `dock`, so all ten shipped
 *     dock quests were rejected on save with "World must be one of the 5
 *     available worlds".
 *
 * So there is no list here. Everything is re-exported from a module GENERATED
 * out of `scripts/quest-vocab.mjs` — the same vocabulary `npm test` judges the
 * seed content with — on every build. See `admin/scripts/gen-quest-vocab.mjs`
 * for why it is baked rather than imported directly.
 *
 * This module is safe in a client component: it carries the lists and the
 * per-world target ids, and none of the resolver's 350 kB of candidate
 * provenance. Server-side validation lives in `lib/questResolver.ts`.
 */

import {
  WORKING_STEP_TYPES,
  DEAD_STEP_TYPES,
  QUEST_WORLDS,
  STEP_WORLDS,
  TARGETS_BY_TYPE,
} from './questVocab.lists.generated.mjs';

/** A world an operator may choose, and the name the game shows for it. */
export type WorldOption = { id: string; displayName: string };

/** A step world additionally records whether its board offers quests at all. */
export type StepWorldOption = WorldOption & { quests: boolean };

/** Step types with a real emitter. An author may pick any of these. */
export const STEP_TYPES: readonly string[] = WORKING_STEP_TYPES;

/**
 * Step types with NO emitter. Never offered; kept so the editor can SAY so
 * when it opens a quest that already contains one.
 */
export const UNFINISHABLE_STEP_TYPES: readonly string[] = DEAD_STEP_TYPES;

/** Worlds a quest may belong to — those whose `makeRules` sets quests:true. */
export const QUEST_WORLD_OPTIONS: readonly WorldOption[] = QUEST_WORLDS;

/**
 * Worlds a STEP may be scoped to: every registered world.
 *
 * Wider than the quest list on purpose. `_advanceSteps` gates a step on the
 * world the player is standing in and on nothing else, so an engagement
 * accepted on a quest-enabled board keeps advancing its ungated steps after the
 * player walks into a quest-less world.
 */
export const STEP_WORLD_OPTIONS: readonly StepWorldOption[] = STEP_WORLDS;

/** step type → world id → the target ids that pair can actually emit. */
export const TARGETS: Readonly<Record<string, Record<string, string[]>>> = TARGETS_BY_TYPE;

/** The target ids a (type, world) pair can emit; empty when the pair is dead. */
export function targetsFor(type: string, world: string): readonly string[] {
  return TARGETS[type]?.[world] ?? [];
}

/** The display name for a world id, falling back to the id itself. */
export function worldLabel(id: string): string {
  return STEP_WORLD_OPTIONS.find((w) => w.id === id)?.displayName ?? id;
}
