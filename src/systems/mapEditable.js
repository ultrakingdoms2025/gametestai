/**
 * Which nodes the map editor may offer, as a flag a world can set on a node.
 *
 * ── What it is for ────────────────────────────────────────────────────────
 * The editor's object picker is "every named node under `world.group`", which
 * is the right default: a world is procedural code and nothing on the server
 * knows what it built. But a few named nodes are not objects an admin could
 * ever mean to move, and offering them is worse than not offering them,
 * because a move on one REPORTS SUCCESS.
 *
 * Two kinds carry it today and both are the same mistake in different shapes:
 *
 *   Collision proxies. A ramp proxy is an invisible tilted box that exists so
 *   a capsule has something to slide on, and `RAMP_PROXY_NAME` is ONE string
 *   shared by every proxy in a world - so the picker showed a single row that
 *   resolved to whichever the traversal reached first, and moving it separated
 *   the thing you walk on from the ramp you can see. Set by `markRampProxy`
 *   in worlds/station/StationKit.js, which the station, the yard and every
 *   ship all call.
 *
 *   Whole populations. `StationActors` draws every fixed figure on the map as
 *   eleven `InstancedMesh`es, one per body part, each named, sitting at depth
 *   2 under `world.group` - so they were near the TOP of the picker. A remove
 *   of `StationActors:head` would decapitate 1,887 people on a green row, and
 *   a move would translate all of them and drag every collider whose centre
 *   lies in a 1,235 m box, uncapped.
 *
 * ── What it does NOT do ───────────────────────────────────────────────────
 * This is a PICKER-SIDE guard and it is not in force at the moment of deploy.
 * Two things follow, and both are deliberate:
 *
 *   A document that ALREADY names one of these still applies. `_applyMove`
 *   and `_applyRemove` resolve with a bare `getObjectByName` and never consult
 *   the catalogue. Refusing at the applier would need a new refusal reason and
 *   its cross-tree pin, which is a separate change; production holds no such
 *   entry (checked against every version of `map_overlays`), so nothing is
 *   waiting on it.
 *
 *   The admin's picker is drawn from the STORED report, not from the live
 *   world, and that report is only rewritten when an admin's own client builds
 *   the world. So a node withheld today keeps appearing until the next report
 *   is taken. Nothing breaks in the gap - the row simply still resolves.
 *
 * ── Why this is its own file ──────────────────────────────────────────────
 * The same reason `overlayVersion.js` is: worlds need this and nothing else of
 * the applier, and importing it from `MapOverlay.js` would drag that file's
 * whole graph - Marketplace, ItemDefs, GroundSampler - into `StationKit.js`
 * and its forty-odd importers. `MapOverlay.js` re-exports it, so its own
 * readers are unchanged.
 */
export const NOT_EDITABLE = 'mapNotEditable';

/** True when `node` must never be offered in the editor's object picker. */
export function isNotEditable(node) {
  return node?.userData?.[NOT_EDITABLE] === true;
}
