/**
 * What a 403 from `/api/admin/**` actually means, said in full, once.
 *
 * ── Why it is a constant and not a sentence in each panel ─────────────────
 *
 * `lib/adminAccess.ts:requireMarketplaceAdmin` returns `null` for a missing
 * session AND for a session whose address is not on the allowlist, and every
 * admin handler maps that one `null` to `{ error: 'Forbidden' }, { status: 403 }`.
 * So the server genuinely cannot say which of the two it was, and any panel
 * that renders the word "Forbidden" on its own has told the operator nothing
 * they can act on — one of the two is fixed by signing in and the other only by
 * an operator editing `ADMIN_EMAILS`.
 *
 * Two panels have to say that, and this repository has been bitten more than
 * once by the same fact written out twice and then corrected in one place. If
 * the allowlist ever starts distinguishing the two cases, this is the single
 * line that stops being true.
 */
export const ADMIN_REFUSED =
  'The admin API refused this request (403). Either your session has expired, or '
  + 'this account is not on the admin allowlist.';
