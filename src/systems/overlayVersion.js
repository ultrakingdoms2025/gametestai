/**
 * The version an overlay document carries, as everything that compares two
 * of them reads it: `max(0, floor(Number(v) || 0))`, so a missing, negative
 * or fractional version is 0 and never a refusal. One clamp for the
 * manager's `builtVersion`, the cache's monotonic write, the applier's
 * `appliedVersion` and its `{id}` gate, so no two of them can disagree about
 * which document is newer.
 *
 * A leaf on purpose: `WorldManager` needs this and nothing else of the
 * applier, and importing it from `MapOverlay.js` dragged that file's whole
 * graph - Marketplace, ItemDefs, Cosmetics, GroundSampler - into every test
 * that only wanted the manager.
 * @param {unknown} doc
 * @returns {number}
 */
export function versionOf(doc) {
  return Math.max(0, Math.floor(Number(doc?.version) || 0));
}
