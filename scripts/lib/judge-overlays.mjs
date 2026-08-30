/**
 * Judge stored overlay documents against the names this tree knows about.
 *
 * Its own module, and not a function inside `scripts/check-stored-overlays.mjs`,
 * for one reason: that file connects to PRODUCTION at import time, so anything
 * that imported it to test the logic would open a database connection. Keeping
 * the judgement here means `npm test` can watch both codes fire without any
 * credentials, and the script stays a thin read-only shell around it.
 *
 * ── The two codes, and why they are not symmetrical ───────────────────────
 *
 * `stale-name` is a WARNING in the site's conflict pass, so a document can be
 * authored dead and still save green. A rename in a Phase 7 release turns every
 * entry that targeted the old name into a row that reports applied and applies
 * to nothing. Spec C1: no name may be retired without an alias table or a
 * migration in the same release.
 *
 * `out-of-bounds` is the only ERROR-level conflict and `hasErrors` refuses the
 * WHOLE document, so one bad row 400s an admin on a row they never touched.
 * Spec C7: bounds may not move in a release that also re-authors placement.
 *
 * ── UNJUDGED is not a pass ────────────────────────────────────────────────
 *
 * Only the station has a catalogue pin in this tree. A name-targeted entry in
 * any other world is reported as UNJUDGED rather than counted clean, because a
 * world nobody is checking must never read as a world with no problems - that
 * is the shape of half the defects this whole effort has turned up.
 */

/**
 * @param {{world_id: string, version: number, entries: unknown}[]} rows head documents
 * @param {Set<string>} known every name the catalogue pin holds
 */
export function judgeOverlays(rows, known) {
  let staleName = 0, outOfBounds = 0, entries = 0, targeted = 0, unjudged = 0;
  const problems = [];
  for (const row of rows) {
    const list = Array.isArray(row.entries) ? row.entries : [];
    for (const e of list) {
      entries++;
      const target = e?.name ?? e?.target ?? null;
      if (target) {
        targeted++;
        if (row.world_id !== 'station') {
          unjudged++;
          problems.push(`UNJUDGED   ${row.world_id} targets "${target}" - no catalogue pin for this world`);
        } else if (!known.has(target)) {
          staleName++;
          problems.push(`STALE-NAME ${row.world_id} v${row.version} -> "${target}" is not in the catalogue`);
        }
      }
      const p = e?.position ?? e?.to ?? null;
      if (p && [p.x, p.y, p.z].some((n) => !Number.isFinite(Number(n)))) {
        outOfBounds++;
        problems.push(`OUT-OF-BOUNDS ${row.world_id} v${row.version} -> ${JSON.stringify(p)}`);
      }
    }
  }
  return { staleName, outOfBounds, unjudged, entries, targeted, problems };
}
