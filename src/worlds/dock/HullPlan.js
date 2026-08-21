/**
 * THE FOUR HULLS, AS NUMBERS.
 *
 * Zero imports, `three` included, for the reason `YardPlan.js` gives: the
 * failures these numbers cause are silent — a rest ledge a mantle refuses to
 * finish on, a cockpit ceiling driven through a dorsal spine, a boarding ramp
 * whose foot hangs 1.6 m over the shed floor — and none of them needs a
 * renderer to catch. The tests read this file rather than re-deriving it, so
 * there is exactly one place a measurement can be changed.
 *
 * Every dimension below is in a hull's OWN frame: **`+Z` is the nose, `+X` is
 * starboard, `y 0` is the cradle's bearing face.** `BERTHS` in `YardPlan.js`
 * carries where that frame sits in the yard.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  THE FOUR NUMBERS EVERY HULL IS SHAPED BY, AND WHERE THEY COME FROM
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **1.12 m — the minimum step-in at a section joint.**
 * `player/Climb.js` places a mantling body `P.radius + LAND_INSET = 0.35 +
 * 0.42 = 0.77 m` inboard of the edge it grabbed, runs `resolveCapsule` there,
 * and REFUSES the mantle if the solver slides the capsule more than 0.20 m. So
 * a ledge needs 0.77 m of flat plus the capsule's own 0.35 m radius before the
 * next wall stands up: **1.12 m**. Every `stepIn` below is 1.15 or more.
 *
 * That is why a hull cannot get its rest ledges from the bolted string course
 * the lore hangs on every section joint — a 0.14 m flange is a handhold the
 * mantle will not finish on. What makes the ledge is the hull STEPPING IN at
 * the joint; the course is the flange bolted over the step.
 *
 * ── AND WHAT THAT NO LONGER DECIDES ───────────────────────────────────────
 * This header used to go on to say that nothing meant to be climbed can be
 * under about 4.6 m in the beam, and that the hulls are therefore stacks of
 * tapering drums. The first half is still arithmetic and the second half was
 * a conclusion drawn from it that need not have been: the numbers govern the
 * BANDS — one station, on one flank, at one height — and say nothing at all
 * about the other 95% of a hull. The priority is shape first now, and the
 * climb wherever the shape affords it, so every dimension below that is not
 * named by a `bands` entry or by a room is free and most of them have moved.
 * Where the two did have to be settled against each other the trade is
 * written down at the site: see `KESTREL.nacelle` and `PIKE.wing`.
 *
 * **[1.0, 2.4] m — the mantle window.** `Climb.MAX_RISE` is 2.4 and
 * `MIN_RISE_GROUND` is 1.0, the latter because the jump apex is
 * `6.4^2 / 44 = 0.93 m` and a mantle under that would only feel like the game
 * taking the controls. Arriving from a climb the floor drops to 0.25.
 *
 * **0.45 m — `CONFIG.player.stepHeight`.** Anything meant to be WALKED up — the
 * Pike's wing onto its ledge — is at or under it, because the capsule solver
 * resolves slopes and does not step up.
 *
 * **13.7 m — one stamina bar of continuous climb.** `DRAIN_UP = 5.4`/s against
 * a 100 bar at `SPEED_UP = 2.05` m/s. Holding on costs only `DRAIN_HOLD = 1.6`,
 * so a ledge is a real rest and any height is reachable given the patience to
 * pause. No band below is over 4.6 m.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  AND THE ONE THE INTERIORS ARE SHAPED BY
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A compartment's `ceilY` is the UNDERSIDE of the deck plate above it, and that
 * plate's top is the ledge the climb rests on. The two are the same slab. Get
 * it wrong by a centimetre in the other direction and the deck plate becomes a
 * full-plan member hanging inside the room under its own ceiling — the fourth
 * occurrence of the defect that put 251 of 407 z-fighting hits and one sealed
 * atrium into the medieval world. `dock-hulls.test.mjs` flags exactly that
 * shape and the plate is exempt only because its top IS the ceiling.
 */

/* ------------------------------------------------------------------ */
/* Shared constants                                                    */
/* ------------------------------------------------------------------ */

/** Plating thickness, and the depth a bulkhead opening is cut through. */
export const SKIN = 0.22;
/** Deck plate thickness. A room's `ceilY` is `ledge.y - DECK_T`. */
export const DECK_T = 0.16;
/** Smallest step-in a mantle can finish on. See the header. */
export const MIN_STEP_IN = 1.12;
/** Tallest rise a mantle takes, and the floor from solid ground. */
export const MANTLE_MAX = 2.4;
export const MANTLE_MIN_GROUND = 1.0;
/** `CONFIG.player.stepHeight`. */
export const STEP_UP = 0.45;
/** One stamina bar of continuous climbing. */
export const CLIMB_BUDGET = 13.7;
/**
 * Clear height under the saddles' top. Every belly starts above this or it is
 * drawn through the bearing blocks the cradle carries the hull on.
 */
export const SADDLE_TOP = 0.36;

/**
 * The brow off the yard's north-bound catwalk crossing onto the Dray's
 * foredeck.
 *
 * ── Why the yard's own crossing is where a hull meets the gantry ─────────
 * The design asked for hull spines topping at 6.6-7.2 m so the last move onto
 * the 8.0 m catwalk is a mantle. Measured against the built yard that cannot be
 * what happens: the four berths are 20-50 m from the perimeter runs, and the
 * two crossings that DO pass over them are railed both sides for their whole
 * length — so the only mantle target above a hull is the 0.11 m top of a
 * handrail, which `resolveCapsule` will not report a body grounded on.
 *
 * What IS true is that `CROSSINGS[0]` passes 1.70 m over the Dray's foredeck.
 * So the yard does what a yard does: cuts the rail and drops a brow.
 * `dock-hulls.test.mjs` walks the whole chain — flank, ledge, foredeck, brow,
 * catwalk — which is quest 55's "get on the gantry the hard way, up the Dray's
 * flank", completable on foot with no jump and no climb.
 */
export const BROW = Object.freeze({
  /** World X of the brow centreline, over the Dray's foredeck. */
  x: 34,
  /** World Z and Y of the FOOT, on the foredeck. */
  footZ: 6.15,
  footY: 6.16,
  /** Up to the crossing deck at `GANTRY_Y` = 8.0. 34.8 degrees. */
  run: 2.65,
  rise: 1.84,
  width: 1.6,
  risers: 5,
  /** Half-width of the gap cut in the crossing's south rail. */
  gapHW: 1.2,
});

/* ------------------------------------------------------------------ */
/* Kestrel — courier, 14 m, berth B1                                   */
/* ------------------------------------------------------------------ */

/**
 * A narrow courier: a short plated midbody between a lofted needle nose and a
 * boat-tail, a raised canopy over the cockpit, a V-tail, and two engine pods
 * carried OUTBOARD on swept pylons.
 *
 * ── The pods moved out, and what that cost and bought ────────────────────
 * They used to sit at local x 2.40-4.00, which is 0.10 m off the flank: a
 * courier with two blisters. They are at 3.00-4.60 now, with a 0.70 m pylon
 * spanning the gap, and the beam over the pods is 9.2 m on a 14 m hull. That
 * is the silhouette — a fuselage with outriggers, legible as a courier from
 * across the shed — and it is the whole reason this hull no longer reads as
 * the same drum as the other three.
 *
 * It is also the one place where beauty and the climb had to be settled
 * against each other rather than assumed. Band two stands on the pod and
 * reaches for the hull flank, and `FreeClimb` reaches `P.radius + REACH =
 * 0.97 m`: the pod's INBOARD edge therefore may not go past `2.30 + 0.97 =
 * 3.27`. It is at 3.00. Any further outboard and the second move of the climb
 * is a reach across open air, so the pods are as far out as the shape allows
 * and no further — which is what "still climbable where shape allows" means
 * when it is written as a number.
 *
 * The climb is still three mantles and no stamina at all — pod at 1.60, ledge
 * at 2.92, crown at 5.16 — because the Kestrel is the starter hull and the
 * first thing a player climbs in this world should teach the move rather than
 * test the bar.
 */
export const KESTREL = Object.freeze({
  id: 'kestrel',
  length: 14,
  z0: -6.2, z1: 7.8,
  belly: Object.freeze({ y0: 0.36, y1: 0.60, hw: 2.05, z0: -4.2, z1: 3.6 }),
  /**
   * The plated midbody, and it is SHORT on purpose: 8.2 m of the 14, from the
   * boat-tail joint to the cockpit's forward bulkhead. Everything outside it
   * is lofted. It used to run -5.6 to 4.6 and the two ends of the hull were
   * therefore a stack of stepped boxes with a drum behind them.
   */
  lower: Object.freeze({ y0: 0.60, y1: 2.92, hw: 2.30, z0: -4.4, z1: 3.8 }),
  /**
   * Top face of the lower section, and it stops at z 1.0 rather than running
   * the length of the hull.
   *
   * That is not styling either. Forward of z 1.0 is the cockpit, and a deck
   * slab over a cockpit is a cockpit with no canopy — the crew compartment
   * ends up in a sealed box under a plate, and the glass drawn over the plate
   * is exactly the painted-lit-interior billboard the station DELETED from its
   * hangar mezzanine rather than turning round. So the slab stops where the
   * glazing starts, and `stepIn` is the flat a mantle lands on.
   */
  ledge: Object.freeze({ y: 2.92, outer: 2.30, inner: 1.15, stepIn: 1.15, z0: -4.4, z1: 1.0 }),
  upper: Object.freeze({ y0: 2.92, y1: 5.02, hw: 1.15, z0: -3.6, z1: 0.8 }),
  /** The walkable dorsal spine. `y` is the TOP face. */
  spine: Object.freeze({ y: 5.16, hw: 1.15, z0: -3.6, z1: 0.8 }),
  /**
   * The canopy, and it is a RAISED glasshouse now rather than a flat plate at
   * the ledge's own level.
   *
   * A flat glazed lid flush with the deck is the single detail that made this
   * hull read as a container: from the floor there is no cockpit in the
   * silhouette at all. It rises to `top` instead, on a coaming, and its
   * UNDERSIDE stays at 2.86 — 0.10 m clear of the cockpit's declared 2.76
   * ceiling, so the compartment is 0.10 m taller than the contract promises
   * and never shorter. Nothing behind it is painted: rule 6.
   */
  canopy: Object.freeze({ z0: 0.8, z1: 3.7, y: 2.86, top: 3.66, hw: 2.05 }),
  /** The nose, forward of the compartment: a lofted needle, no interior. */
  nose: Object.freeze({ z0: 3.8, z1: 7.8, y0: 0.60, y1: 2.92 }),
  /** The boat-tail, aft of the engine bulkhead. Lofted, sealed, no interior. */
  tail: Object.freeze({ z0: -6.2, z1: -4.4, y0: 0.60, y1: 2.92 }),
  /**
   * Two engine pods, carried outboard. Their tops are the first move of the
   * climb, so `y1` and the flat between `x0` and `x1` are both load-bearing:
   * the mantle lands 0.77 m inboard of `x1` and the capsule is 0.35 m in
   * radius, so the top has to be flat for 1.12 m in from the outer face.
   */
  nacelle: Object.freeze({ x0: 3.00, x1: 4.60, y0: 0.60, y1: 1.60, z0: -6.6, z1: -2.9 }),
  /**
   * The swept pylon between flank and pod, and the drag strut behind it.
   *
   * ── The pod and the pylon both moved 1.3 m aft, and it was the DOOR ──────
   * They used to run z -5.8..-1.6 and -3.3..-1.7. The boarding hatch is at
   * z -1.50 and the ramp runs out from it across z -2.30..-0.70, so both of
   * them stood in the way of the only route into this ship: the pylon's loft
   * reached z -1.70 at local x 2.28..3.00 and y 0.86..1.66 — knee to chest
   * height, dead across the aft third of the doorway, which is 5 of the 81
   * samples the aperture probe fires — and the pod's forward collider at
   * z -2.50..-1.30, x 3.22..4.38, y 0.38..1.18 sat ON the ramp, whose surface
   * at those stations is y 0.30..0.51. A player walking up the ramp met the
   * inside of an engine pod.
   *
   * At -6.6..-2.9 the pod's nose is 0.33 m clear of the aperture's own pocket
   * and 0.60 m clear of the ramp, its bells project 0.74 m aft of the transom
   * at z -6.94 (which is what an engine looks like), and the pylon at
   * -4.35..-3.05 lands on plating that is still full-beam — `lower.z0` is
   * -4.4, and a pylon rooted any further aft would be floating off the
   * boat-tail's taper.
   *
   * The two climb bands that grip the pod moved with it: see `bands`.
   *
   * `y1` is 1.56 and not 1.66, which is 0.04 m UNDER the pod's own top face.
   * `bands[1]` stands a body on that face at local x 3.20, and a 0.35 m capsule
   * reaches x 2.85 — inboard of the pylon's outer edge at 3.00. A pylon whose
   * collider topped out at 1.66 was therefore a 0.06 m lip inside the capsule
   * that the mantle finishes in, and `resolveCapsule` pushes off it. The loft
   * still draws to 1.66: it is 0.06 m of fairing standing proud of a face the
   * body already meets, which is `relief`'s rule and not a ledge.
   */
  pylon: Object.freeze({ z0: -4.35, z1: -3.05, y0: 0.86, y1: 1.56 }),
  /**
   * The V-tail: two fins splayed 34 degrees off vertical, rooted on the
   * boat-tail. Nothing mantles onto them and nothing stands under them — the
   * spine deck ends at z -3.6 and these start at -4.3.
   */
  vtail: Object.freeze({ rootX: 0.30, rootY: 2.48, z: -5.15, span: 2.85, cant: 0.66, chordRoot: 1.65, chordTip: 0.78 }),
  rooms: Object.freeze([
    Object.freeze({ id: 'cabin', z0: -3.4, z1: 0.6, hw: 2.08, floorY: 0.76, ceilY: 2.76 }),
    Object.freeze({ id: 'cockpit', z0: 0.8, z1: 3.4, hw: 2.08, floorY: 0.76, ceilY: 2.76 }),
  ]),
  deck: Object.freeze({ y: 0.76, z0: -3.5, z1: 3.5, hw: 2.08 }),
  /** The archway between them: no door, because two rooms 0.2 m apart is one room. */
  arch: Object.freeze({ z: 0.7, hw: 0.9, h: 2.0 }),
  hatch: Object.freeze({ lz: -1.5, w: 1.1, h: 2.0 }),
  /** Ramp off the cradle top. 26 degrees; `headX` is the flank it meets. */
  ramp: Object.freeze({ from: 'cradle', lz: -1.5, headX: 2.35, headY: 0.76, width: 1.6, risers: 5 }),
  /** Every move from the cradle top to the crown, and what kind of move it is. */
  /**
   * Every move from the cradle top to the crown, what kind of move it is, and
   * the geometry the probe has to find to believe it.
   *
   * `faceX` is the local X of the OUTER face the hand goes on; `standX` is
   * where the feet are while reaching for it, chosen so the gap is inside
   * `FreeClimb`'s `P.radius + REACH = 0.97 m`; `z` is a station along the hull
   * where that face is unobstructed. Written down rather than derived because
   * a probe that computed its own stance would be testing its own arithmetic.
   */
  bands: Object.freeze([
    /* `z: -4.8` and it used to be -3.7. Both of these moves happen ON the pod
     * — the first grips its outer face, the second stands on its top — and the
     * pod's parallel run, the only part of it that is full width AND full
     * height, is now z -5.6..-4.0. A station at -3.7 would grip a taper. */
    Object.freeze({ from: 0, to: 1.60, how: 'mantle', what: 'cradle top to the engine pod', faceX: 4.60, standX: 5.20, z: -4.8 }),
    /* And this one is at -4.2 rather than -4.8, which is the ONLY station on
     * this hull where both halves of the move exist. The body stands on the
     * pod, so it needs the pod's parallel run (-5.6..-4.0); its hand goes on
     * the hull flank at 2.30, and the plated section starts at `lower.z0` =
     * -4.4 — aft of that the boat-tail is a chamfered loft and the three-ray
     * fan finds no face with `|n.y| <= 0.5` at all. At -4.8 it found none, and
     * said so. */
    Object.freeze({ from: 1.60, to: 2.92, how: 'mantle', what: 'pod to the section ledge', faceX: 2.30, standX: 3.20, z: -4.2 }),
    Object.freeze({ from: 2.92, to: 5.16, how: 'mantle', what: 'ledge to the dorsal spine', faceX: 1.15, standX: 1.85, z: -1.5 }),
  ]),
});

/* ------------------------------------------------------------------ */
/* Dray — ore tender, 28 m, berth B2                                   */
/* ------------------------------------------------------------------ */

/**
 * The mining ship, and the only hull in the yard with a room you would call a
 * room: a 9 x 6 x 3.4 m hold with a cargo ramp to the shed floor, an engine
 * room aft of a dogged bulkhead, a raised cockpit forward under the foredeck,
 * and a cargo lift from the hold floor to the dorsal spine.
 *
 * ── Why a lift and not a ladder ──────────────────────────────────────────
 * `Interiors` has exactly two verbs — hinged doors and vertical lifts — and a
 * ladder is neither. A ladder-shaped hole between the hold and the spine is a
 * one-way drop: the player gets down and cannot get back. `setBoxColliderY` is
 * Y-only and safe precisely because the broadphase is XZ-indexed, which is what
 * makes a lift legal where a moving walkway is not.
 *
 * ── Where the design's arithmetic did not close ──────────────────────────
 * The brief specified "one 6-step flight hold -> cockpit (rise 0.4, tread
 * 0.5)", i.e. 2.4 m. The hold floor is at 1.00 and the foredeck plate that is
 * the cockpit's own deckhead is at 4.40, so a cockpit floor at 3.40 leaves a
 * 1.0 m compartment. Five risers of 0.26 over a 2.1 m run land it at 2.30 with
 * a 2.10 m ceiling and come out at 31.7 degrees, well inside the ~45 degree
 * ceiling on what the capsule solver will walk.
 */
export const DRAY = Object.freeze({
  id: 'dray',
  length: 28,
  z0: -14, z1: 14,
  belly: Object.freeze({ y0: 0.40, y1: 0.84, hw: 4.70, z0: -12.5, z1: 10.5 }),
  lower: Object.freeze({ y0: 0.84, y1: 4.56, hw: 5.20, z0: -13.0, z1: 11.0 }),
  ledge: Object.freeze({ y: 4.56, outer: 5.20, inner: 4.05, stepIn: 1.15 }),
  upper: Object.freeze({ y0: 4.56, y1: 6.40, hw: 4.05, z0: -12.0, z1: 2.0 }),
  spine: Object.freeze({ y: 6.54, hw: 4.05, z0: -12.0, z1: 2.0 }),
  /**
   * The foredeck is the forward half of the SAME slab the ledge is the top of.
   * Aft of z 2.0 the superstructure stands on it and leaves a 1.15 m side deck
   * each flank; forward of it the full 10.4 m beam is open.
   *
   * It stays at 4.56 rather than being carried up with the spine because the
   * yard's catwalk crossing runs over this berth with its collided deck at
   * 7.86 m world. At 6.16 world there is 1.70 m under the walkway, which is
   * what the brow then descends.
   */
  foredeck: Object.freeze({ y: 4.56, hw: 5.20, z0: 2.0, z1: 11.0 }),
  /**
   * The companionway from the foredeck up to the spine. It runs AFT (`run` is
   * negative) and comes up through a hole in the spine deck, because the
   * superstructure's forward face is open and a flight arriving under a solid
   * deck would be a stair to a ceiling. 1.98 m at 30.2 degrees.
   *
   * ── WHY THE FOOT IS AT 2.9 AND NOT 4.0 ────────────────────────────────────
   * `ShipKit.flight` collides a flight as ONE rotated box whose TOP face is the
   * slope, which puts its underside `thickness / cos(pitch)` — 0.55 m — below
   * the treads. The foredeck plate this flight stands on is only `DECK_T` =
   * 0.16 m thick and the COCKPIT is directly under it, `z 3.2..6.6`, ceiling
   * 4.40. With the foot at z 4.0 the proxy's forward end reached z 4.10 and its
   * underside hung 0.39 m through that plate into the room below: measured by
   * raycasting up from the cockpit sole on a 0.2 m grid against the proxy,
   * clear height was **1.76 m minimum with 11.5% of the floor under 1.9** —
   * against a compartment that declares 2.10, a repo `HEADROOM` of 1.9, and a
   * standing capsule of 1.75. Worse, it hung over the cockpit's own doorway:
   * `stair` arrives at z 2.8 and `cockpitArch` is at 3.1.
   *
   * Moving the foot aft to 2.9 puts the proxy's forward end at z 3.03, clear of
   * the room, and the run shortens to 3.40 so the HEAD still lands on the aft
   * edge of `spineHole` at z -0.5 — the relation `spineHole` exists to hold.
   * The pitch goes from 23.7 to 30.2 degrees, still well inside the ~44 the
   * capsule solver reports true normals for.
   */
  foreStep: Object.freeze({ lz: 2.9, rise: 1.98, run: -3.40, width: 2.2, risers: 7 }),
  /**
   * The hole in the spine deck the companionway comes up through.
   *
   * Its aft edge and the flight's HEAD are the same line, and that is the whole
   * of why the run is 4.5 m and not the 2.8 first drawn. A shorter flight tops
   * out in the middle of the hole with 1.6 m of open air between its last tread
   * and the deck: the probe walked the stair, reported every tread, and then
   * reported the spine as unreachable — a flight to nothing, which is this
   * project's signature defect at 1/50 scale.
   */
  spineHole: Object.freeze({ lx: 0, lz: 1.1, half: 1.5 }),
  bowCap: Object.freeze({ z0: 11.0, z1: 14.0, hw: 2.4, y0: 1.4, y1: 4.56 }),
  /**
   * The bridge castle, standing on the after end of the spine deck.
   *
   * ── Why it is AFT, and why it stops at z -6.4 ─────────────────────────────
   * Two routes cross this deck and both of them are published elsewhere. The
   * companionway from the foredeck arrives through `spineHole` at z 1.1, and
   * `dock-reach` floods to the spine's own midpoint at `(spine.z0 + spine.z1)
   * / 2` — which is z -5.0. A castle amidships would land on the first and a
   * castle reaching z -5.0 would land on the second, so it sits at the stern
   * with 8.5 m of open deck ahead of it and 1.4 m of clearance behind the
   * probe point.
   *
   * That is also the profile the ship wants: engine aft, bridge over it,
   * derrick and well deck forward. It is a bulk carrier and it reads as one
   * from the far end of the shed.
   */
  bridge: Object.freeze({ z0: -9.6, z1: -6.6, hw: 3.30, y0: 6.54, y1: 9.10 }),
  /**
   * The derrick: a mast on the forward end of the deckhouse and a lattice boom
   * raked out over the foredeck.
   *
   * `tipZ` and `tipY` are held where they are by the yard, not by the ship.
   * `CROSSINGS[0]` at world z 10 passes over this berth at about local z 12.2,
   * so a boom reaching the bow would be inside the catwalk; and the foredeck
   * under the boom is walked, so the hook cannot hang lower than head height
   * over it. Tip at (10.2, 8.6) clears the crossing by 2 m of hull and the
   * deck by 4 m.
   */
  /* `hookY` is the underside of the GRAPPLE HEAD, and it used to be 6.90 — a
   * block on a 1.70 m wire. See the note at `Hulls.buildDray`: a mass hanging
   * on a fall is a statement about gravity, and it is why four reviews in a row
   * called this ship a harbour tug. It is a stowed telescopic ram now, 0.75 m
   * under the tip, and the deck clearance the paragraph above is about gets
   * BETTER rather than worse — 4.0 m becomes 5.7 m over the foredeck at 4.56. */
  derrick: Object.freeze({
    mastX: 0, mastZ: -1.6, mastTop: 12.2, heelY: 7.1,
    tipZ: 9.2, tipY: 8.6, hookY: 7.85,
  }),
  /**
   * Four ore hoppers on the deck house top, outboard of the walking lane.
   *
   * `lane` is the half-width kept clear down the centre of the spine, and it
   * is 1.2 rather than 0.7 because `dock-reach` puts a 0.35 m capsule on the
   * centreline and a probe that just fits is a probe that fails the next time
   * anything is added beside it.
   */
  hoppers: Object.freeze({ x: -2.75, r: 1.20, y0: 6.54, y1: 9.3, zs: Object.freeze([-5.2, -2.4]) }),
  /**
   * The radiator bank, cantilevered off the STARBOARD flank of the deckhouse
   * and nothing to port. The asymmetry is the point: it is the one feature on
   * any of the four hulls that tells you which way round you are looking at
   * it, and a working ship's heat exchangers are exactly the thing that would
   * be bolted onto whichever side had room.
   *
   * `y0` is 2.04 m over the side deck at 4.56, so a 1.75 m body walks under it.
   */
  radiator: Object.freeze({ x0: 3.4, x1: 6.4, y0: 7.40, y1: 9.00, z0: -9.4, z1: -6.8, fins: 5 }),
  rooms: Object.freeze([
    Object.freeze({ id: 'hold', z0: -6.0, z1: 3.0, hw: 3.00, floorY: 1.00, ceilY: 4.40 }),
    /**
     * `hw` is 3.00 and it used to be 2.00, which is the SAME number as the
     * hold's for the same reason: it is the beam of the sole under it.
     *
     * `deck.hw` is 3.12 and the sole runs the full length of the ship at that
     * width, so bulkheads at `hw + 0.12` = 2.12 left 1.00 m of floor by 5.2 m
     * of length OUTBOARD of them on each flank - floored, ceilinged by the
     * ledge plate, and with no door into it. `dock-hulls` found it and it was
     * the one red in the suite: "a standable surface at local (-2.7, 1.00,
     * -10.5) is in no declared compartment and on no route".
     *
     * Neither of the two obvious repairs works. Stopping the plate at 2.12
     * exposes the BELLY top instead - `belly.y1` is 0.84 and the belly is
     * solid to hw 4.7 - and the probe came back with the same four samples
     * 0.16 m lower. Filling the pocket with solid tankage cuts the engine
     * room's own starboard walking lane, which was routed THROUGH the pocket:
     * driven, `dray/engine` went from reachable to "BUILT but cannot be
     * entered from the gateway", because at z -7.0 the lane at local x 1.5 is
     * blocked and the only way aft on that side was outboard of the bulkhead.
     *
     * So the room is declared the width it is actually built: bulkheads land
     * on the plate edge exactly as the hold's do, there is no pocket, and the
     * lane that was already being walked is now inside the compartment that
     * owns it. */
    Object.freeze({ id: 'engine', z0: -11.0, z1: -6.0, hw: 3.00, floorY: 1.00, ceilY: 3.60 }),
    Object.freeze({ id: 'cockpit', z0: 3.2, z1: 6.6, hw: 1.40, floorY: 2.30, ceilY: 4.40 }),
  ]),
  deck: Object.freeze({ y: 1.00, z0: -11.2, z1: 3.1, hw: 3.12 }),
  /** Hold -> cockpit. 31.7 degrees. See the class note. */
  stair: Object.freeze({ z0: 0.7, rise: 1.30, run: 2.10, width: 1.4, risers: 5 }),
  /** Dogged hatch in the aft bulkhead of the hold. */
  engineHatch: Object.freeze({ lz: -6.0, w: 1.2, h: 2.0 }),
  /** The opening from the flight head into the cockpit. */
  cockpitArch: Object.freeze({ z: 3.1, hw: 0.7, h: 2.0 }),
  /** Cargo lift, hold floor to spine. Its shaft is a hole in both decks. */
  lift: Object.freeze({ lx: 1.9, lz: -3.2, half: 1.15, stops: Object.freeze([1.00, 6.54]) }),
  /** The cargo door in the flank, and the ramp to the shed floor through it. */
  hatch: Object.freeze({ lz: -1.5, w: 3.0, h: 2.6 }),
  /**
   * `headY` is the LOCAL height the ramp arrives at — the hold floor — and not
   * the rise. The two are the same number on a hull that boards off its cradle
   * and they are not on one that boards off the shed floor: this ramp starts
   * 1.6 m lower, so a builder reading `headY` as a rise makes it 4.2 m long
   * instead of 2.6 and its foot lands 5 m past the apron anchor the yard
   * published for it.
   */
  ramp: Object.freeze({ from: 'deck', lz: -1.5, headX: 5.15, headY: 1.00, width: 2.6, risers: 14 }),
  /**
   * Every move from the cradle top to the crown, what kind of move it is, and
   * the geometry the probe has to find to believe it.
   *
   * `faceX` is the local X of the OUTER face the hand goes on; `standX` is
   * where the feet are while reaching for it, chosen so the gap is inside
   * `FreeClimb`'s `P.radius + REACH = 0.97 m`; `z` is a station along the hull
   * where that face is unobstructed. Written down rather than derived because
   * a probe that computed its own stance would be testing its own arithmetic.
   */
  bands: Object.freeze([
    Object.freeze({ from: 0, to: 4.56, how: 'climb', what: 'cradle top up the flank to the ledge', faceX: 5.20, standX: 5.90, z: -8.0 }),
    Object.freeze({ from: 4.56, to: 6.54, how: 'mantle', what: 'ledge to the dorsal spine', faceX: 4.05, standX: 4.70, z: 0.5 }),
  ]),
});

/* ------------------------------------------------------------------ */
/* Pike — interceptor, 18 m, berth B3                                  */
/* ------------------------------------------------------------------ */

/**
 * Guns, no room, no cargo. A narrow trunk inside a wide hull, a gun bay you can
 * only get into on your knees, and the yard's dorsal access scaffold alongside
 * so the spine can be reached without a hand on the plating.
 *
 * ── The gun bay is FORWARD of the cockpit, not under it ──────────────────
 * The brief put it under a floor hatch. A 1.5 m compartment reached by dropping
 * through the deck is a compartment you cannot climb out of: `Interiors` has no
 * ladder, the crouch capsule is `1.75 * 0.58 = 1.015 m` and the standing one is
 * 1.75, and there is not enough headroom in there to jump. That is a soft lock,
 * which is the one failure this drop exists to prevent. So it is a crouch hatch
 * through the forward bulkhead at deck level: 1.0 m wide, 1.35 m to the lintel,
 * a hole you go through on your knees and come back out of the same way.
 */
export const PIKE = Object.freeze({
  id: 'pike',
  length: 18,
  z0: -7.5, z1: 10.5,
  belly: Object.freeze({ y0: 0.38, y1: 0.54, hw: 2.05, z0: -6.2, z1: 4.6 }),
  lower: Object.freeze({ y0: 0.54, y1: 2.76, hw: 2.35, z0: -6.5, z1: 6.4 }),
  /** Aft of the cockpit only — see the note on `KESTREL.ledge`. */
  ledge: Object.freeze({ y: 2.76, outer: 2.35, inner: 1.20, stepIn: 1.15, z0: -6.5, z1: 0.4 }),
  upper: Object.freeze({ y0: 2.76, y1: 4.46, hw: 1.20, z0: -4.5, z1: 0.2 }),
  spine: Object.freeze({ y: 4.60, hw: 1.20, z0: -4.5, z1: 0.2 }),
  /** The bubble: a glazed roof over the cockpit, at the ledge's own level. */
  canopy: Object.freeze({ z0: 0.4, z1: 3.4, y: 2.76, hw: 1.35 }),
  /** The fairing over the gun bay, and the nose forward of it. */
  fairing: Object.freeze({ z0: 3.4, z1: 6.4, y0: 2.20, y1: 2.76, hw: 1.6 }),
  nose: Object.freeze({ z0: 6.4, z1: 10.5, y0: 0.54, y1: 2.76 }),
  /**
   * The wings — a swept DIAMOND planform, not the rectangular sponsons this
   * hull was built with.
   *
   * ── The upper surface is flat and that is the whole trick ────────────────
   * Their top at 2.36 is a 2.36 m mantle off the cradle top — inside
   * `[1.0, 2.4]` — and it stands 0.40 m under the ledge, which is inside
   * `stepHeight`, so the Pike can still be topped out without a hand on the
   * plating. A mantle needs a top face at `normal.y >= 0.7` and 1.12 m of flat
   * inboard of the edge it grabbed, so ALL of the section's taper is taken out
   * of the underside: flat over, knife under. That is also what a lifting body
   * looks like, so nothing was given up to keep the climb.
   *
   * ── Why the tip is at z 0.2 and not at the trailing edge ─────────────────
   * `bands[0]` grips the wingtip at local x 5.60 at station z 0, and the
   * outrigger strut carries that face down to 0.54 so `Climb._probe` finds a
   * wall at 0.45, 0.95 and 1.45 m over the feet. A wing swept back to a tip
   * behind z -1 would put nothing at all at that station. So the planform is a
   * diamond with its widest point ON the band's station rather than a delta
   * with its tip aft: leading edge sweeps back, trailing edge sweeps forward,
   * and the two meet where the climb needs them to.
   */
  wing: Object.freeze({
    x0: 2.20, x1: 5.60, y0: 1.95, y1: 2.36, z0: -2.0, z1: 2.0,
    /** Leading and trailing edge stations at the root and at the tip. */
    leadRoot: 3.05, trailRoot: -2.75, leadTip: 0.95, trailTip: -0.55,
    /** Underside at the root and at the tip; the top is `y1` throughout. */
    botRoot: 1.86, botTip: 2.19,
  }),
  /** Ventral fins under the wingtips: they hang BELOW, so nothing mantles them. */
  ventral: Object.freeze({ x: 5.05, y0: 1.10, y1: 2.10, z0: -0.9, z1: 0.9, cant: 0.42 }),
  /** A swept, tapered fin. `hw` is the root half-thickness. */
  fin: Object.freeze({ hw: 0.22, y0: 4.46, y1: 6.90, z0: -6.9, z1: -3.4, tipZ0: -6.5, tipZ1: -5.1 }),
  /** The two cannon, running forward out of the fairing over the gun bay. */
  cannon: Object.freeze({ x: 0.92, y: 1.94, z0: 4.6, z1: 11.4, r: 0.14 }),
  /** The trunk walls that make a 2.4 m cockpit inside a 4.7 m hull. */
  trunk: Object.freeze({ hw: 1.25, t: 0.10 }),
  rooms: Object.freeze([
    /* The entry bay is not padding. The boarding hatch has to clear the gun
     * sponsons — their underside is at 1.95 and a body walking the cradle top
     * is 1.75 m tall, so a ramp UNDER a wing has 0.20 m to spare and a ramp
     * through one has none. Aft of the sponsons is the only flank a ramp fits
     * against, and the compartment behind that flank is this one. */
    Object.freeze({ id: 'entry', z0: -4.8, z1: 0.4, hw: 1.20, floorY: 0.70, ceilY: 2.60 }),
    Object.freeze({ id: 'cockpit', z0: 0.6, z1: 3.2, hw: 1.20, floorY: 0.70, ceilY: 2.60 }),
    Object.freeze({ id: 'gunbay', z0: 3.3, z1: 6.3, hw: 0.80, floorY: 0.70, ceilY: 2.20 }),
  ]),
  deck: Object.freeze({ y: 0.70, z0: -5.0, z1: 6.4, hw: 1.20 }),
  /** The crouch hole. 1.35 m to the lintel against a 1.015 m crouch capsule. */
  crouchHatch: Object.freeze({ z: 3.25, hw: 0.5, h: 1.35 }),
  hatch: Object.freeze({ lz: -3.9, w: 1.0, h: 1.95 }),
  ramp: Object.freeze({ from: 'cradle', lz: -3.9, headX: 2.40, headY: 0.70, width: 1.5, risers: 5 }),
  /**
   * The yard's dorsal access scaffold, alongside to starboard rather than up
   * the centreline: a flight up the keel would pass through the stern engine
   * block at 3.56 m, which is a stair whose middle third is inside a ship.
   * 36.0 degrees.
   */
  /**
   * `bridgeZ` is the CENTRE of the head deck, and it sits FORWARD of the
   * flight's head rather than over it.
   *
   * The first version centred it on the head, so the deck's own underside hung
   * 0.41 m over the last 0.7 m of ramp — and a walk probe is right to say that
   * a tread with 0.41 m of clearance is not standable. The flight climbed to
   * within 0.55 m of its own landing and stopped, which is over `stepHeight`,
   * so the scaffold delivered a player to nowhere.
   */
  scaffold: Object.freeze({ lx: 3.30, footZ: -12.0, rise: 5.80, run: 7.98, width: 1.5, risers: 16, bridgeZ: -3.27, deckZ0: -4.07, deckZ1: -2.47, deckX0: 0.70, deckX1: 4.20 }),
  /**
   * Every move from the cradle top to the crown, what kind of move it is, and
   * the geometry the probe has to find to believe it.
   *
   * `faceX` is the local X of the OUTER face the hand goes on; `standX` is
   * where the feet are while reaching for it, chosen so the gap is inside
   * `FreeClimb`'s `P.radius + REACH = 0.97 m`; `z` is a station along the hull
   * where that face is unobstructed. Written down rather than derived because
   * a probe that computed its own stance would be testing its own arithmetic.
   */
  bands: Object.freeze([
    Object.freeze({ from: 0, to: 2.36, how: 'mantle', what: 'cradle top to the gun sponson', faceX: 5.60, standX: 6.10, z: 0 }),
    Object.freeze({ from: 2.36, to: 2.76, how: 'step', what: 'sponson to the section ledge', faceX: 2.35, standX: 3.00, z: 0 }),
    Object.freeze({ from: 2.76, to: 4.60, how: 'mantle', what: 'ledge to the dorsal spine', faceX: 1.20, standX: 1.80, z: -2.0 }),
  ]),
});

/* ------------------------------------------------------------------ */
/* Bastion — frigate hulk, 44 m, berth B4                              */
/* ------------------------------------------------------------------ */

/**
 * The scale-setter. Plated and climbable over her middle, open frames forward
 * where the bow cap was never fitted, and a whole stern section still standing
 * on the shed floor aft of the cradle because nobody has pinned it on.
 *
 * No interior — but a doorless `enterables` descriptor all the same
 * (`medieval/Treasures.js:556-566`): it buys the entire collectible streaming
 * path for one array entry and no rooms at all.
 *
 * Her crown is at 9.54 m world, higher than the gantry, which is the point of
 * her: she is the thing that tells you how big the shed is.
 */
export const BASTION = Object.freeze({
  id: 'bastion',
  length: 44,
  z0: -22, z1: 22,
  belly: Object.freeze({ y0: 0.50, y1: 0.80, hw: 7.20, z0: -17, z1: 11 }),
  lower: Object.freeze({ y0: 0.80, y1: 4.00, hw: 8.00, z0: -18, z1: 12 }),
  ledge: Object.freeze({ y: 4.00, outer: 8.00, inner: 6.20, stepIn: 1.80 }),
  upper: Object.freeze({ y0: 4.00, y1: 7.20, hw: 6.20, z0: -16, z1: 10 }),
  spine: Object.freeze({ y: 7.34, hw: 6.20, z0: -16, z1: 10 }),
  /**
   * The open bow. Frames only, and capped at 4.00 rather than carried on at
   * 7.20 for the same reason the Dray's foredeck is: the catwalk crossing at
   * `CROSSINGS[1]` runs over this berth with its collided deck at 7.86 m world,
   * and the hull reaches local z 18.1 under it.
   */
  openBow: Object.freeze({ z0: 12, z1: 22, hw: 7.4, y0: 0.8, y1: 4.0, frames: 6 }),
  /** The unfitted stern section, standing on the shed floor aft of the cradle. */
  sternRibs: Object.freeze({ z0: -35, z1: -24, hw: 7.6, y0: -2.2, y1: 5.4, frames: 5 }),
  /** The engine bell on its stand, beside the cradle. */
  bell: Object.freeze({ lx: -11.5, lz: -13, r0: 1.5, r1: 3.2, y0: -2.2, y1: 2.4 }),
  /**
   * The stripped bays: runs of flank where the plating was taken off and the
   * frames left standing.
   *
   * This is what makes a 44 m hull read as a WRECK from across the shed rather
   * than as the biggest of four drums, and it is the one hull that can afford
   * it: she has no interior at all, so a hole in her side opens onto solid
   * fill and there is nothing behind it to see.
   *
   * The runs are chosen against the climb rather than at random. `bands` grip
   * the flank at z -6.0 on both moves, so the plating there is untouched;
   * these are aft of -8 and forward of +2, which are also the two places the
   * eye goes first from the apron.
   */
  stripped: Object.freeze([
    Object.freeze({ z0: -15.5, z1: -8.6, y0: 1.35, y1: 3.30 }),
    Object.freeze({ z0: 2.4, z1: 9.0, y0: 1.35, y1: 3.30 }),
  ]),
  /**
   * Two barbettes on the spine — the turret rings she was never armed with —
   * and the barrel that was delivered and never lifted, lying on the deck.
   *
   * `dock-reach` does not flood to this spine (`spineAccess` is 'climb') and
   * `bands[1]` lands at local x 5.43 from the flank at 6.20, so both rings sit
   * inboard of x 3.0 and neither is in the way of the mantle.
   */
  barbette: Object.freeze({ r: 2.6, h: 1.15, zs: Object.freeze([-9.5, 2.5]) }),
  /**
   * The conning tower, aft on the spine. 13.4 m over the shed floor, which is
   * the tallest thing in this yard that is not the roof: she is the scale
   * setter and this is the part of her that sets it.
   */
  tower: Object.freeze({ z0: -14.6, z1: -11.2, hw: 3.6, y0: 7.34, y1: 11.2 }),
  /**
   * Every move from the cradle top to the crown, what kind of move it is, and
   * the geometry the probe has to find to believe it.
   *
   * `faceX` is the local X of the OUTER face the hand goes on; `standX` is
   * where the feet are while reaching for it, chosen so the gap is inside
   * `FreeClimb`'s `P.radius + REACH = 0.97 m`; `z` is a station along the hull
   * where that face is unobstructed. Written down rather than derived because
   * a probe that computed its own stance would be testing its own arithmetic.
   */
  bands: Object.freeze([
    Object.freeze({ from: 0, to: 4.00, how: 'climb', what: 'cradle top up the flank to the ledge', faceX: 8.00, standX: 8.70, z: -6.0 }),
    Object.freeze({ from: 4.00, to: 7.34, how: 'climb', what: 'ledge up the upper flank to the crown', faceX: 6.20, standX: 7.00, z: -6.0 }),
  ]),
});

/** Everything, by hull id. */
export const HULLS = Object.freeze({ kestrel: KESTREL, dray: DRAY, pike: PIKE, bastion: BASTION });

/** The three that are fitted out and walkable this drop. */
export const WALKABLE = Object.freeze(['kestrel', 'dray', 'pike']);

/**
 * Which side of a hull's local frame the yard put its boarding ramp on.
 *
 * The berth aprons all lie between the cradle and the keel line, and the hulls
 * are yawed, so "the side facing the keel line" is a different local axis on
 * each of them. Deriving it from the published anchor rather than writing four
 * signs down is what stops a ramp being authored on the far flank — where it
 * would be a ramp to a wall: built, reachable, and pointless.
 *
 * @param {{x:number,z:number,yaw:number,apron:{x:number,z:number}}} berth
 * @returns {1|-1} the sign of local X the ramp runs out along
 */
export function boardSide(berth) {
  const dx = berth.apron.x - berth.x;
  const dz = berth.apron.z - berth.z;
  // Local +X maps to world (cos yaw, -sin yaw). See `GeoBatch.localAt`.
  const dot = dx * Math.cos(berth.yaw) - dz * Math.sin(berth.yaw);
  return dot >= 0 ? 1 : -1;
}
