/**
 * The canonical lore scopes, in their canonical order.
 *
 * ── Why this is not exported from `lore.ts`, where the order lives ─────────
 *
 * The ordered list's home is the `ORDER BY CASE` inside `lore.ts` — but
 * `lore.ts` imports `pg` at module scope, so a client component (the owner
 * panel's scope dropdown) cannot import anything from it without dragging a
 * Node-only driver into the browser bundle and failing the build. This module
 * imports nothing, which is the same argument `mapOverlaySchema.ts` makes for
 * itself.
 *
 * The two are pinned together rather than trusted to agree:
 * `contentDropdowns.test.ts` parses the `WHEN '<scope>' THEN <n>` pairs out of
 * `lore.ts`'s source and fails if they are not exactly this list in exactly
 * this order. Editing one without the other is a red test, not a quiet drift.
 *
 * `space` is here although it is not a world with a gateway: it is a lore
 * SCOPE (the yard's second keeper recites it), which is precisely why this
 * list is not `OVERLAY_WORLDS` and must never be replaced by it.
 *
 * Note this is the CANONICAL list, not an allowlist: `upsertServerLore`
 * deliberately accepts scopes outside it, because "a scope the platform has
 * never had is pure addition" is shipped merge behaviour (`lore.ts`, and
 * `loreScoping.test.ts` exercises it). The dropdown offers these; an existing
 * row with a legacy scope is shown as a labelled legacy option rather than
 * silently rewritten.
 */
export const LORE_SCOPES = [
  'overall',
  'station',
  'medieval',
  'sports',
  'citadel',
  'race',
  'maze',
  'dock',
  'space',
] as const;

export type LoreScope = (typeof LORE_SCOPES)[number];
