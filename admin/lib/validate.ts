import { z } from 'zod';
import { resolveQuestWorld, resolveTarget } from './questResolver';

export const loginSchema = z.object({
  username: z.string().min(1).max(64).trim(),
  password: z.string().min(1).max(256),
  totp:     z.string().length(6).regex(/^\d{6}$/),
});

export const playerQuerySchema = z.object({
  page:   z.coerce.number().int().min(0).default(0),
  search: z.string().max(256).optional(),
});

export const revokeSchema = z.object({
  playerId: z.string().uuid(),
  reason:   z.string().max(500).optional(),
});

export const creditSchema = z.object({
  playerId: z.string().uuid(),
  delta:    z.number().int().min(-100_000).max(100_000),
  reason:   z.string().max(500).optional(),
});

export const configSetSchema = z.object({
  key:         z.string().min(1).max(128).regex(/^[a-z0-9_.]+$/),
  value:       z.string().max(4096),
  description: z.string().max(256).optional(),
});

/* ---------------------------------------------------------------------- */
/* Quests                                                                  */
/* ---------------------------------------------------------------------- */

/**
 * A quest step, as the operator's step editor serialises it.
 *
 * ── Why a schema, when the editor is a set of selects ──────────────────────
 *
 * Because it was not one. `saveQuest` accepted the steps field on one test —
 * `Array.isArray(parsed) && parsed.length > 0` — so a hand-rolled POST could
 * write `{type:'stealth', target:'nightshade', count:99}` straight into the
 * `quests` table, and even through the UI the selects offered five types with
 * no emitter in `src/`. Either way the result is a quest a player can accept
 * and can NEVER finish; the engine has no way to say so, because a step it
 * cannot advance simply never advances.
 *
 * The shape is checked here; whether the step is REACHABLE is checked by
 * `scripts/quest-vocab.mjs`'s own resolver, reached through
 * `lib/questResolver.ts`. That split matters — the shape is this app's
 * business, the vocabulary is the game's, and re-implementing the second here
 * is exactly how the editor's step-type list drifted in the first place.
 *
 * The bounds are the authored content's own bounds with room over: the widest
 * seeded quest has 10 steps, the longest label 238 characters and the largest
 * count 12.
 */
export const questStepSchema = z.object({
  order:  z.coerce.number().int().min(1).max(64),
  label:  z.string().trim().min(1, 'every step needs a label').max(300),
  type:   z.string().trim().min(1).max(32),
  target: z.string().trim().max(120).default(''),
  count:  z.coerce.number().int().min(1, 'count must be a whole number of 1 or more').max(999),
  world:  z.string().trim().max(32).default(''),
});

export type QuestStepInput = z.infer<typeof questStepSchema>;

/** More than this is not a quest, it is a to-do list. Widest seeded quest: 10. */
export const MAX_QUEST_STEPS = 24;

/**
 * A quest save: the world it stands on, and the steps it asks for.
 *
 * Validated as one object rather than two because a step's world defaults to
 * the QUEST's world, so neither half can be judged alone.
 */
export const questSaveSchema = z
  .object({
    world: z.string().trim().min(1, 'a quest must name the world whose board it stands on').max(32),
    steps: z.array(questStepSchema).max(MAX_QUEST_STEPS),
  })
  .superRefine((value, ctx) => {
    /* A quest authored into a world with `quests: false` can never reach a
     * board, so `accept()` could never find it however reachable its steps
     * are. The resolver says which worlds those are and why. */
    const board = resolveQuestWorld(value.world);
    if (!board.ok) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['world'], message: board.detail });
    }

    value.steps.forEach((step, index) => {
      // A blank step world means "wherever the quest is", which is what the
      // editor's "-- same --" option writes and what the seeder assumes.
      const world = step.world || value.world;
      const verdict = resolveTarget(step.type, step.target, { world });
      if (!verdict.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['steps', index], message: verdict.detail });
      }
    });
  });

export type QuestSaveInput = z.infer<typeof questSaveSchema>;

/**
 * Turn the first failure into one sentence an operator can act on.
 *
 * Named steps rather than paths: "Step 3 (Win the rooftop run): ..." tells the
 * operator which row of the editor to look at, where `steps.2` does not. The
 * explanation itself is the resolver's, verbatim — it names the emitter, the
 * world and the near-misses, and rewording it here would be a second, worse
 * copy of the game's own account of itself.
 */
export function describeQuestSaveError(
  error: z.ZodError,
  steps: ReadonlyArray<{ label?: unknown; order?: unknown }>
): string {
  const issue = error.issues[0];
  if (!issue) return 'Quest could not be validated';
  const [head, index] = issue.path;
  if (head === 'steps' && typeof index === 'number') {
    const step = steps[index];
    const order = Number(step?.order) || index + 1;
    const label = String(step?.label ?? '').trim();
    return `Step ${order}${label ? ` (${label})` : ''}: ${issue.message}`;
  }
  if (head === 'world') return `World: ${issue.message}`;
  return issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message;
}

export type LoginInput     = z.infer<typeof loginSchema>;
export type PlayerQuery    = z.infer<typeof playerQuerySchema>;
export type RevokeInput    = z.infer<typeof revokeSchema>;
export type CreditInput    = z.infer<typeof creditSchema>;
export type ConfigSetInput = z.infer<typeof configSetSchema>;