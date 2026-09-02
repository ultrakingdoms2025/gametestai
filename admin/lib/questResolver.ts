/**
 * The quest step resolver, typed. SERVER ONLY.
 *
 * `resolveTarget` and `resolveQuestWorld` are `scripts/quest-vocab.mjs`'s own
 * functions — the same source text, over the same candidate lists, generated
 * into `lib/questVocab.resolver.generated.mjs` at build time and checked
 * verdict-for-verdict against the original by the generator. So a step the
 * console accepts is a step `npm test` accepts, and a step it refuses is
 * refused in the same words.
 *
 * Do NOT import this from a client component: the candidate table carries the
 * provenance of every id in the game and is about 350 kB. `lib/questVocab.ts`
 * is the small, client-safe half.
 */

import {
  resolveTarget as rawResolveTarget,
  resolveQuestWorld as rawResolveQuestWorld,
} from './questVocab.resolver.generated.mjs';

/** One thing the engine can put in the candidate list for a step type. */
export type Candidate = { value: string; kind: string; source: string };

/**
 * A verdict. `reason` is a machine token (`dead-type`, `unknown-target`,
 * `quests-disabled`, …); `detail` is the sentence to show the operator, and it
 * is written by the vocabulary rather than by this app, on purpose — the
 * explanation of WHY a step cannot complete belongs beside the evidence.
 */
export type Verdict = {
  ok: boolean;
  reason: string | null;
  detail: string;
  matched: Candidate | null;
  candidates: number;
};

/** Can a player ever satisfy this step target, in the world the step names? */
export function resolveTarget(
  type: string,
  target: string | null | undefined,
  opts: { world?: string | null } = {}
): Verdict {
  return rawResolveTarget(type, target, opts) as Verdict;
}

/** Can a quest whose own `world` is this one ever be offered to a player? */
export function resolveQuestWorld(world: string | null | undefined): {
  ok: boolean;
  reason: string | null;
  detail: string;
} {
  return rawResolveQuestWorld(world) as { ok: boolean; reason: string | null; detail: string };
}
