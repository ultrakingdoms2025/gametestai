import * as THREE from 'three';
import { AlienShip, ALIEN_CLASSES, buildAlienModel } from '../npc/AlienShip.js';
import { SHIP_CLASSES, SHIP_BASE_STATS, SHIP_STAT_META } from './ShipStats.js';
import { DOCK_ANCHOR } from '../worlds/space/Bodies.js';

/**
 * LASERS, BOTH WAYS.
 *
 * ===========================================================================
 *  WHY THIS IS NOT `systems/Projectiles.js`
 * ===========================================================================
 *
 * The brief said to reuse `Projectiles` "or say so if you must write a
 * space-scale version". Here is the saying-so, with the numbers.
 *
 * `Projectiles` is a good system and every one of its decisions is correct for
 * the world it was written in - and every one of them is wrong here:
 *
 *   SPEED. An arrow is 80 m/s and a fireball is 52. A laser bolt has to
 *   outrun a Kestrel doing 455 m/s under boost, and be quick enough that a
 *   500 m shot is a lead problem rather than a prayer. Ours is 1,600 m/s -
 *   twenty times a fireball.
 *
 *   WHAT IT HITS. Every `Projectiles` shot resolves through `physics.raycast`
 *   against the world's collider set, then `npcManager.raycastNPCs` against
 *   humanoid capsules. Out here there are no colliders within 26 km of the
 *   yard (the belt's rocks are the nearest, and they are 26 km to port), and
 *   there are no NPCs - a hostile craft is not an `NPC`, it has no capsule and
 *   no `Grounding`. Both of its two hit paths would be dead code every frame.
 *
 *   WHAT IT DRAWS. Trails, embers, smoke, scorch decals on surfaces, stuck
 *   arrows, shockwaves and three pooled point lights. There are no surfaces to
 *   scorch in vacuum, no smoke to hang in it, and `RIG_BUDGET.point` is 12 for
 *   the whole game with every one of them compiled into every shader in every
 *   world - three more, live, in the world with the most expensive shaders, is
 *   not a trade worth making for a flash that bloom already draws.
 *
 *   HOW MANY. `MAX_PROJECTILES` is 32. Two skiffs and a lance firing bursts of
 *   two and three at 1,350 m/s over 500 m, plus a player holding the trigger
 *   at five a second, saturates 32 in about a second and a half - at which
 *   point `spawn` starts recycling the oldest LIVE bolt, and shots begin
 *   vanishing mid-flight.
 *
 * So: a second pool, 128 bolts, two draw calls, swept against spheres. What is
 * NOT rewritten is the thinking - the sweep-the-segment-you-are-about-to-cross
 * rule is `Projectiles`' and it is inherited verbatim, because at 1,600 m/s a
 * bolt moves 26.7 m per fixed step and a point test against a 4.2 m skiff
 * would miss it six times out of seven.
 *
 * ===========================================================================
 *  WHAT MAKES THE UPGRADE LADDER MATTER
 * ===========================================================================
 *
 * `ShipStats.SHIP_STAT_META` has sold `fire` as "15% laser damage" and
 * `shield` as "10% less hull damage" since the customiser shipped, and
 * `Ship.applyPowers` has been banking both into `_fireTier` and `_shieldTier`
 * ever since - applied to nothing. `Ship.js` records why that was allowed:
 * *"a purchase whose entire effect is a slightly earlier lap time is
 * indistinguishable from a purchase that did nothing"*, and the mitigation was
 * to ship the wiring early and the effect later. This is the later.
 *
 *   fireTier   -> `1 + 0.15 * tier` on every bolt, which is the panel's own
 *                 number applied literally. Base bias counts: a Pike is
 *                 `fire: 4` out of the box, so it leaves the yard at x1.60
 *                 while a Kestrel leaves at x1.15.
 *   shieldTier -> BOTH halves, and this is the one place the published copy
 *                 needed a decision. `SHIELD_PER_TIER` metres of shield pool
 *                 per tier is the new thing; "10% less hull damage" is honoured
 *                 exactly as written on whatever gets THROUGH the pool. A
 *                 Dray (`shield: 3`) therefore carries 165 points of shield and
 *                 takes 30% less on the hull; a Kestrel carries 55 and takes
 *                 10% less. That is the difference between an ore tender that
 *                 can be shot at and a courier that cannot.
 *
 * Neither is read off the private `Ship` instance. Both are recomputed here
 * from `SHIP_BASE_STATS` plus `ShipRegistry.getPowers`, which is the same
 * arithmetic `Ship.applyPowers` does from the same two public sources - so a
 * hull the registry has not adopted yet (which happens for one frame after a
 * world change) still has the right gun.
 *
 * ===========================================================================
 *  ENCOUNTER PLACEMENT, WHICH IS THE HARD PART
 * ===========================================================================
 *
 * Citadel's lesson was that content placed where nobody goes is invisible; the
 * brief adds that content dumped on the player is worse. Both are placement
 * problems and both are solved by the same three rules:
 *
 *   1. ZONES SIT ON THE ROUTES THE PLAYER ALREADY FLIES. `SpaceWorld` publishes
 *      them (see `SpaceWorld._fillEncounters`) and every one of them is on the
 *      dock-to-Cinder line or at Halberd Reach, because those are the only two
 *      places in 800 km that a player has a reason to be. A picket parked in
 *      empty space at a random bearing is the zero-reachable-wildlife defect
 *      with guns.
 *
 *   2. NOTHING SPAWNS NEAR THE YARD. `SAFE_RADIUS` is 9 km and it is checked at
 *      the spawner, not just at the zone, so a zone that were ever authored too
 *      close still could not fire. The nearest authored zone is 20 km out.
 *
 *   3. THEY ARRIVE AHEAD OF YOU, OUTSIDE WEAPONS RANGE, AND HOLD FIRE. The
 *      launch cone is 600-850 m and biased into the forward hemisphere, so a
 *      wing appears as three contacts you can see coming; `holdFire` gives
 *      1.2 s of warning before the first bolt. Never behind, never inside
 *      `SPAWN_MIN`, never while docked, landed or mid-seam.
 *
 * ===========================================================================
 *  INTERDICTION, AND THE ONE LINE IT COSTS ELSEWHERE
 * ===========================================================================
 *
 * `Piloting`'s transit multiplies displacement by eight while the throttle is
 * pinned and nothing is within 4 km. Without a hook, every encounter in this
 * file would be flown past at 3,640 m/s before the first burst landed - the
 * fight would exist and never happen, which is this project's signature defect
 * in a new costume.
 *
 * So `SpaceCombat` writes `piloting.interdicted` and `Piloting._clearOfEverything`
 * reads it. That is the entire change to a file this drop does not own, it is
 * two lines, and it is the genre's own answer: something has a lock on you, so
 * you are in normal space until it does not.
 *
 * ===========================================================================
 *  THE ENGAGEMENT GEOMETRY, WHICH WAS WRONG AND IS NOW MEASURED
 * ===========================================================================
 *
 * The complaint was "combat is invisible at range", and it was right. It is
 * not a VFX bug and it was not fixed with one: the hulls are authored at real
 * scales - a skiff is 9.9 m long and 11.0 m across the blades - and a ship you
 * can see because it is the size of a house is a worse lie than a fight that
 * happens at 300 m. So the DISTANCE moved and the hulls did not.
 *
 * -- HOW MANY PIXELS IS A SKIFF ---------------------------------------------
 *
 * `CONFIG.render.fov` is 75 degrees VERTICAL. The image plane at range d is
 * `2 * d * tan(37.5deg) = 1.5347 * d` world units tall, mapped to 1080 rows,
 * so at 1080p:
 *
 *     pixels = 1080 / 1.5347 * (metres / range) = 703.7 * metres / range
 *
 * `.probe/engagement.mjs` parks a real hostile at a real range and projects
 * ITS OWN VERTICES through the live camera, so this is a measurement and not
 * a derivation. Skiff (11.0 m span), 1920x1080, largest screen extent:
 *
 *     range     arithmetic   measured   what the screenshot shows
 *     1250 m       6.2 px      5.0 px   indistinguishable from a star
 *     1100 m       7.0 px      7.1 px   the complaint's "~6 px". Nothing.
 *      780 m       9.9 px      9.9 px   4 violet pixels at 4x magnification;
 *                                       NOTHING in the unzoomed frame - and
 *                                       780 m was the skiff's own gun range
 *      520 m      14.9 px     14.6 px   a smudge with a long axis
 *      420 m      18.4 px     17.9 px   an object; blades leave the body
 *      300 m      25.8 px     24.6 px   a SHAPE with a facing: swept wings,
 *                                       amber leading edge, a nose
 *      200 m      38.7 px     35.6 px   a craft you can watch bank
 *      130 m      59.5 px     51.9 px   the merge
 *
 * The threshold is not taste either: the design's own cue is the pair of
 * forward-swept blades whose runners sit 3.4 m off the spine, and two glow
 * features 3.4 m apart need about 8 px between them to survive the bloom -
 * which is `703.7 * 3.4 / 8 = 299 m`. The wings become wings at 300 m.
 *
 * -- WHAT MOVED -------------------------------------------------------------
 *
 *     skiff gun      780 -> 420 m     the fight band is [130, 420]
 *     lance gun      900 -> 520 m     16.4 m of arms; 22 px at its own reach
 *     spawn shell   900-1250 -> 600-850 m
 *     player gun    1000 -> 700 m     still 180 m past the heaviest hostile
 *     convergence    550 -> 380 m     the reticle is true where the fight is
 *     hold fire      1.8 -> 1.2 s     the first bolt arrives inside 400 m
 *
 * -- IS 420 m SURVIVABLE, OR IS IT A FLYBY ---------------------------------
 *
 * The band is 290 m wide. Closure decides whether that is a fight:
 *
 *     head-on, both flat out    210 + 174 = 384 m/s   0.76 s   a merge
 *     player throttled to 100   100 + 174 = 274 m/s   1.06 s   a pass
 *     hostile in ATTACK inside 320 m it throttles to 0.72 -> 125 m/s
 *     a turning fight            50-150 m/s          2-6 s     the fight
 *
 * A head-on merge is 0.76 s and always was; that is what a merge IS. What
 * changed is that the TURNING part - `ATTACK` runs up to `ATTACK_LIMIT`
 * seconds and both craft are circling at 125-210 m/s - now happens inside
 * 420 m instead of inside 780 m, so the several seconds a player spends
 * tracking a target are spent on 18-52 px of ship rather than on 8-18.
 *
 * -- AND THE OTHER HALF: A WING MUST NOT BE FLOWN PAST AT 5,000 m/s ---------
 *
 * `Flight`'s transit drive tops out at 5,000 m/s and a picket's trigger sphere
 * is 4,200 m, which is 0.84 seconds of it. The old spawner launched the wing
 * on the step the sphere was entered - while the player was still at transit
 * speed - and `interdicted` was only written AFTERWARDS, so the drive spent
 * `transitSpoolDown` (1.2 s) shedding 5,000 m/s to cruise and the ship was
 * about 3 km past the wing before its first bolt. The wing then had to catch a
 * faster ship from astern, which it cannot. The encounter existed and did not
 * happen: this project's signature defect, again.
 *
 * So arming and launching are now two different things. Crossing into a zone
 * ARMS it, which writes `interdicted` immediately - the drive drops and the
 * displacement multiplier is cancelled the same step - and the wing launches
 * only once `flight.transitState` is back to `off`. The player is therefore
 * always in normal space when three craft appear 600-850 m ahead, which is
 * what that standoff was always supposed to buy and never did.
 *
 * The arm is on a LEASH rather than on the sphere, because a drive shedding
 * 5,000 m/s covers about 3.1 km doing it and would otherwise coast out of the
 * trigger it had just fired.
 *
 * -- HOW YOU LEAVE ---------------------------------------------------------
 *
 * Being pinned is the failure mode a transit drop-out invites, so the lock is
 * a CLOCK and not a flag: you are held while the fight is on and something has
 * either had you inside its own gun range or been gaining on you within
 * `LOCK_GRACE` (12 s). Break contact and hold it, and the drive comes back.
 *
 * It is deliberately not a radius. Two were tried and both were measured out
 * of existence - see the note on `LOCK_GRACE`, which is worth reading before
 * anyone tries a third, because the reason is structural rather than a matter
 * of tuning: a normal break-off opens 11,015 m on its own.
 *
 * What it costs, flown: a hull that can out-run the wing is free about twelve
 * seconds after it breaks contact; a hull that cannot is held until the wing
 * gives up. `DISENGAGE` stands the wing down at 3,600 m either way.
 */

/* ------------------------------------------------------------------ */
/* Constants. Each one is stated against the thing it is measured on.  */
/* ------------------------------------------------------------------ */

/**
 * The player's gun, at `fireTier` 0. Damage is multiplied by the tier.
 *
 * 16 damage and 95 skiff integrity is six hits from a stock Kestrel (x1.15 ->
 * 18.4) and four from a stock Pike (x1.60 -> 25.6). At the sustained rate
 * below that is 1.8 s and 1.2 s of time-on-target respectively, which is a
 * dogfight rather than a click.
 */
export const GUN = Object.freeze({
  damage: 16,
  /** m/s. Fast enough that 500 m is a lead problem, not a prayer. */
  speed: 1600,
  /**
   * Metres. 700, from 1,000.
   *
   * Two floors and one ceiling decide this number and none of them is taste:
   *
   *   IT MUST OUT-REACH THE HEAVIEST HOSTILE. The lance shoots at 520 m, so
   *   a player who flies a good merge gets 180 m of opening fire that cannot
   *   be answered. That is the reward for pointing your nose first.
   *   IT MUST BE SEVERAL TURN RADII. A stock Kestrel turns in 148 m at cruise
   *   and every hull in the yard turns in the same 148 m (see `Flight`), so
   *   700 m is 4.7 radii - an arena with room for the knife.
   *   IT MUST BE INSIDE `Scale.NEAR_FIELD` (1400 m), out to which `Backdrop`
   *   draws everything at its TRUE position, so the thing you are shooting at
   *   is where the maths says it is.
   *
   * 1,000 m satisfied all three and was still wrong, because a gun that
   * reaches 1,000 m invites shooting at 1,000 m, and at 1,000 m a skiff is
   * seven pixels. A range you cannot aim inside is not reach, it is a tease.
   */
  range: 700,
  /** Seconds between shots when the capacitor can pay for them. 5/s. */
  interval: 0.20,
  /**
   * Capacitor. 100 units, 9 a shot, 30/s back, and NO recharge delay.
   *
   * The delay is the interesting part of this note. It was 0.35 s, on the
   * reflex that a gun should have a vent - and 0.35 s of dead time after every
   * shot, on top of the 9/30 = 0.3 s it takes to afford the next one, means a
   * sustained rate of 1/(0.35 + 0.3) = 1.54 shots a second. Against a burst
   * rate of five that is not a capacitor, it is a jam: measured in the browser
   * at 2 shots in 1.2 seconds while the trigger was held, which reads as the
   * gun being broken rather than as a resource being managed.
   *
   * With no delay the ladder is the one the design wanted and a player can
   * feel: eleven shots at 5/s straight off a full charge, then a steady
   * 30/9 = 3.33/s for as long as you hold it. The cliff is visible on the bar
   * and it is a decision; the jam was neither.
   */
  capacity: 100,
  cost: 9,
  regen: 30,
  regenDelay: 0,
});

/**
 * Metres up the nose line where the two guns cross, and the furthest a muzzle
 * may sit from the keel. Both exist because of the Dray - see `_playerGun`.
 *
 * 380 is `GUN.range * 0.54`, and it is deliberately the same point `_drawAim`
 * puts the reticle at: the crosshair is exact exactly where the bolts meet.
 *
 * It came in from 550 with the rest of the envelope, and the guarantee it has
 * to keep is arithmetic. A bolt aimed at the convergence point is
 * `span * (1 - d / CONVERGE)` off the axis at range d; the widest span the cap
 * allows is `MAX_SPAN`, and a skiff's hit sphere is 4.2 m. Over the whole new
 * envelope [110 m, 700 m]:
 *
 *     110 m   3.2 * (1 - 0.289) =  2.28 m   hit
 *     275 m   3.2 * (1 - 0.724) =  0.88 m   hit   <- the median of the fight
 *     700 m   3.2 * (1 - 1.842) = -2.69 m   hit
 *
 * so a maximum-span hull hits a stationary skiff sitting on the reticle at
 * every range it can shoot from, which is a stronger claim than 550 m made.
 */
export const CONVERGE = 380;
export const MAX_SPAN = 3.2;

/**
 * WIDE DISPERSAL: the fan a `laser_cell` buys, and the arithmetic for it.
 *
 * The gun is a capacitor and it stays one - see `GUN` above and the note over
 * `laser_cell` in `systems/ItemDefs.js`. A cell does not feed it. What a cell
 * buys is thirty seconds during which the same trigger pull lays down EIGHT
 * bolts across an arc instead of two down one line, so a pass through a wing
 * can touch more than one craft.
 *
 * -- THE CORE PAIR SURVIVES INSIDE THE FAN, AND THAT IS THE WHOLE DESIGN ----
 *
 * The first build of this walked ALL the bolts apart, the middle of them
 * included, and it was measured and rejected. It kept a bolt exactly on the
 * nose line at every range - so the crosshair stayed true - but it moved the
 * CONVERGENT PAIR OUT, and past 120 m a single craft sitting on the pip then
 * took one bolt where the stock gun lands two. Half damage. A cell is handed
 * out 20 and 40 at a time by the first two rungs of the kill ladder, which a
 * player reaches straight out of a dogfight, so the first thing most players
 * would ever do with one is spend it and find their gun worse against the next
 * skiff. That reads as a bug rather than as a trade, and no comment in this
 * file is ever read by the person forming that opinion.
 *
 * So the requirement is an invariant now rather than a balance judgement:
 *
 *     SINGLE-TARGET DAMAGE ON A CRAFT SITTING ON THE CROSSHAIR IS NEVER
 *     WORSE THAN THE UNMODIFIED GUN, AT ANY RANGE IN [110 m, 700 m].
 *
 * and it is bought structurally rather than by tuning. TWO CORE BOLTS ARE THE
 * STOCK GUN, UNTOUCHED - muzzle at `span * +-1`, aimed at the convergence
 * point, zero pitch. Everything the Dray paragraph in `_playerGun` says about
 * them is still true of them, because they ARE them: they land on a target on
 * the pip at every range exactly as they do today. The extra bolts are then
 * hung OUTWARD from those two, in rings.
 *
 * -- THE GEOMETRY -----------------------------------------------------------
 *
 * Every bolt still leaves one of the two muzzles the ship has always had. The
 * fan is made entirely by walking AIM POINTS outboard, which is what a gun
 * spreading its dispersion actually does and is why no new gun ports appear on
 * the hull. For muzzle side `s = +-1` and ring `k = 0..RINGS`:
 *
 *     muzzle = keel + right * (span * s)                        (as now)
 *     aim    = convergence point + right * (FAN_PITCH * k * s)
 *     off(d, s, k) = s * [ span * (1 - d/CONVERGE) + k * FAN_PITCH * (d/CONVERGE) ]
 *
 * `k = 0` is `off(d, s, 0) = s * span * (1 - d/CONVERGE)`, which is the stock
 * pair's own formula with nothing added - so `RINGS = 0` is today's gun rather
 * than an approximation of it, and the loop in `_playerGun` collapses to the
 * one it has always had.
 *
 * -- THE TABLE. `span = MAX_SPAN` (3.2), which is every hull but the Kestrel;
 * the Kestrel's 14 m gives 3.08 and moves nothing below by more than 0.12 m --
 *
 *              core pair    ring step    widest bolt   full fan   bolts on a
 *              (= today)    (adjacent)                  width     4.2 m sphere
 *                                                                 on the pip
 *     110 m     +-2.27 m      3.18 m      +-11.83 m     23.7 m         2
 *     275 m     +-0.88 m      7.96 m      +-24.77 m     49.5 m         2 <- median
 *     380 m     +-0.00 m     11.00 m      +-33.00 m     66.0 m         2
 *     700 m     -+2.69 m     20.26 m      +-58.09 m    116.2 m         2
 *
 * (At 700 m the core pair has CROSSED - the bolt from the left muzzle is
 * 2.69 m right of the axis - which is convergence doing precisely what it is
 * for, and is why that row is written the other way up.)
 *
 * WHY 11 M A RING. Because it is the widest step that is still GAPLESS at the
 * range the fight is actually fought at. A skiff's hit sphere is 4.2 m, so a
 * craft slips between two bolts once they are more than 8.4 m apart; the step
 * is `FAN_PITCH * d / CONVERGE`, and `8.4 = P * 275/380` solves to P = 11.61.
 * 11 is that rounded down, which puts the last gapless range at
 * `8.4 * 380 / 11 = 290 m` - fifteen metres past the median rather than right
 * on top of it. Inside 290 m the fan is a continuous wall with nowhere for a
 * craft to sit; outside it, it is a comb, and that is stated rather than
 * hidden. The core pair is never the hole: `2 * span * |1 - d/CONVERGE|` peaks
 * at 6.4 m (d = 0) and is 5.39 m at 700, under 8.4 everywhere in the envelope.
 *
 * WHY THREE RINGS, AND WHY AN EVEN COUNT. Three because `3 * 11 = 33`, which
 * puts the outermost bolt on `span * (1 - d/C) + 33 * (d/C)` - the exact
 * envelope of the rejected build, at every range in the table above. What was
 * reviewed and sent back was the SHAPE and not the width, so the width is
 * deliberately unchanged and the whole of the difference is that the middle of
 * the fan is now the stock pair instead of a single on-axis bolt. Even,
 * therefore, and no centre bolt: with a convergent core the crosshair is
 * already true, so a bolt on the axis would be a THIRD permanent on-pip hit -
 * a flat x1.5 single-target damage buff at every range, which is a balance
 * change nobody asked for and the mirror image of the error being fixed.
 *
 * WHAT THE WIDTH IS WORTH. A second craft is caught wherever some bolt is
 * within 4.2 m of it, so the fan covers a continuous band of
 * `+-(widest + 4.2)`: +-16.0 m at 110 m and +-29.0 m at 275 m.
 * `AlienShip._intercept` carries the only measurement in the repository of how
 * far apart a wing actually flies - three skiffs over seven seconds of run-in
 * separated by 452-504 m on average and CLOSEST 21-33 m - and +-29 m at the
 * median is sized to that closest approach. Sized to the MEAN it would be
 * hundreds of metres wide and aiming at nothing.
 *
 * -- WHAT IT COSTS, WHICH IS NOW NOTHING ------------------------------------
 *
 * The last column of the table is the invariant, held: two bolts on an on-pip
 * target at every range, which is exactly what the stock gun does. By band:
 *
 *     x2.0   inside ~50 m   (48.7 m at `MAX_SPAN`, 53.7 m on a Kestrel - the
 *                            first ring is still within 4.2 m of the axis
 *                            there. `BREAK_RANGE` is 130 m, so this is nearer
 *                            than a hostile will willingly come.)
 *     x1.0   50 m to 700 m  (the core pair, and only the core pair)
 *
 * The floor is x1.0 and there is no band beneath it. That is also why no
 * per-bolt damage adjustment is applied: there is nothing left to compensate
 * for, and scaling damage down would now BREAK the invariant this arrangement
 * exists to hold.
 *
 * The gain is entirely lateral, and it is real. The stock pair misses anything
 * more than about 7.4 m off the crosshair; the fan puts a bolt on anything
 * within 29 m of it at the median range. That is a second craft, and it is
 * also forgiveness on the first.
 *
 * -- AND IT COSTS NOTHING EXTRA AT THE CAPACITOR ----------------------------
 *
 * `GUN.cost` is unchanged while the fan is up. A wider shot that also drained
 * faster would cut the rate of fire as well, so the player would pay twice for
 * one effect. The cell is the price.
 *
 * -- THE POOL ---------------------------------------------------------------
 *
 * `MAX_BOLTS` is 128. Eight bolts at the burst rate of five a second is 40 a
 * second, each alive `GUN.range / GUN.speed` = 0.44 s, so 18 of the player's
 * are in flight at the peak and 12 at the sustained 3.33/s. Six hostiles
 * firing bursts do not come close to the remaining 110.
 */
export const FAN_BOLTS = 8;
export const FAN_PITCH = 11;

/** Shield pool per point of `shieldTier`. See the ladder note in the header. */
export const SHIELD_PER_TIER = 55;
/** Floor, so a hull with no shield bias is still not made of paper. */
export const SHIELD_FLOOR = 40;
/** Points per second, once `SHIELD_DELAY` has passed without a hit. */
export const SHIELD_REGEN = 9;
export const SHIELD_DELAY = 4.5;

/**
 * What one Shield Recharge Cell puts back into the absorption pool.
 *
 * 110, which is `SHIELD_PER_TIER * 2` and is derived rather than picked: a
 * cell is worth two tiers of pool, so it is decisive on the `SHIELD_FLOOR`
 * hull a new pilot flies (40, refilled outright and then some) and still short
 * of a full refill on a well-fitted one (tier 3 is 165). A cell that always
 * filled the bar would make the shield ladder in the Fitting Shop pointless -
 * why buy a bigger tank when a bottle fills any tank - and one sized off the
 * floor alone would be a rounding error to the pilots who fight the longest.
 *
 * ── WHY THE POOL NEEDED A BOTTLE AT ALL ───────────────────────────────────
 * `_playerHit` sets `_shieldIdle = 0` on every hit and `_regen` only refills
 * after `SHIELD_DELAY` seconds without one. In a live engagement that gap does
 * not occur, so the shield structurally cannot recover during the fight it
 * exists for: it is a one-shot buffer that empties and stays empty until the
 * player disengages. This is the only thing in the game that refills it under
 * fire, and it is the only consumable space has that is not a weapon.
 */
export const SHIELD_CELL_CHARGE = 110;

/** No hostile may exist within this of the yard mouth. Rule 2 in the header. */
export const SAFE_RADIUS = 9000;
/**
 * Launch shell around the player: never nearer, never further. 600-850, from
 * 900-1250.
 *
 * Both ends are pinned to something:
 *
 *   THE FAR END is as far out as a craft can be and still be SEEN arriving.
 *   At 850 m a skiff is 9 px and a lance 14 - a moving speck, but a speck the
 *   contact marker is now pointing at, so "three sparks you can see coming"
 *   becomes true for the first time. Past that it is a HUD event with nothing
 *   under it, which is what 1,250 m was.
 *   THE NEAR END is outside the heaviest hostile's own gun (520 m), so nothing
 *   ever arrives already shooting - and `space-combat.test.mjs` asserts
 *   exactly that, per class, so the two numbers cannot drift apart.
 *
 * The shell is now reached in normal space rather than at transit speed - see
 * `_spawner` - which is what makes a 600 m standoff a closing engagement
 * instead of 0.12 s of it.
 */
export const SPAWN_MIN = 600;
export const SPAWN_MAX = 850;
/**
 * Seconds a fresh wing may not fire for. The warning. 1.2, from 1.8.
 *
 * It is a DISTANCE dressed as a time: at a 300 m/s closure 1.8 s is 540 m of
 * dead space, which from a 700 m spawn put the first bolt at 160 m - past the
 * merge, so the opening pass had no shots in it at all. At 1.2 s it is 360 m
 * and the first bolt arrives at about 340 m, which is inside the range where
 * the player can see what is shooting at them. That is the entire point of
 * the number and it was not being met.
 */
export const HOLD_FIRE = 1.2;

/**
 * THE HULL ALARM. The warning that was not there.
 *
 * Driven cold, a whole session ended like this and nothing else was said:
 *
 *     "3 hostile contacts - Cinder high orbit."     (info toast)
 *     "Autopilot returned the hull to Lodestar Yard."  (warn toast)
 *     player:died { killerId: "laser" }
 *
 * Integrity read 100 on the last check the player made before it happened. 27
 * points of damage arrived across one engagement with no on-screen cue that
 * the hull - as opposed to the shield - was being opened at all.
 *
 * Two rungs, because one is a threshold and two is a trend: a pilot who sees
 * DAMAGED and then CRITICAL knows which way it is going and has a decision to
 * make (run for the yard, or press). `WARN_HOLD` is how long the banner sits
 * up and `WARN_REPEAT` how often it comes back while the hull stays under -
 * a one-shot alarm on the frame you cross 34% is an alarm nobody sees.
 */
export const HULL_WARN_FRAC = 0.55;
export const HULL_CRIT_FRAC = 0.28;
export const WARN_HOLD = 3.4;
export const WARN_REPEAT = 6.0;
/** Leave the fight by this much and the wing stands down. */
export const DISENGAGE = 3600;
/**
 * THE MASS LOCK, AND WHY IT IS A CLOCK RATHER THAN A RADIUS.
 *
 * `interdicted` used to mean "any hostile is alive anywhere", which with
 * `DISENGAGE` at 3,600 m denied the transit drive for as long as it took to
 * open 3.6 km - about ninety seconds at the 36 m/s a stock Kestrel gains on a
 * skiff at cruise, most of it spent well outside the hostiles' own 420 m guns,
 * flying in a straight line, not being shot at, and unable to leave. Taking a
 * hit drops you out of transit (`Piloting._breakTransit`), so that stretch was
 * also un-re-enterable. That is being pinned by bookkeeping.
 *
 * ── A RADIUS WAS THE OBVIOUS ANSWER AND IT IS THE WRONG ONE ────────────────
 *
 * Two of them were tried and both were measured out of existence:
 *
 *   1,500 m failed `space-combat.test.mjs` in one line. `Piloting`'s
 *   displacement multiplier covers 1,680 m/s while the throttle is pinned, so
 *   a player holding W - which is what a player travelling DOES - opened
 *   1,500 m in under a second and a half and left without a decision.
 *
 *   2,200 m failed `space-objectives.test.mjs`, and the trace is worth
 *   keeping: at t=48 s a two-skiff wing broke off, and by t=55 s the gap had
 *   opened to 2,298 m ON ITS OWN - the player was orbiting the zone, not
 *   running. The lock fell off, the multiplier spooled to x8, and the wing
 *   stood down at t=56 s. A guns-cold ablation shook a live encounter by
 *   doing nothing at all.
 *
 * The second failure is not a tuning problem, it is structural: this file's
 * own `a hostile merges, breaks off, separates, and comes back` case measures
 * the separation a normal break produces, and it is far past any radius worth
 * having - so a lock radius below it fires during a fight the player is still
 * in, and one at or above it is the flag we started with.
 *
 * ── AND THE NUMBER THAT SENTENCE USED TO CARRY WAS WRONG ──────────────────
 *
 * It read "3,590 m ... `DISENGAGE` is 3,600 m precisely BECAUSE that is where
 * a break-off tops out". That 3,590 m came off a headless rig which boarded
 * through `Piloting.board` in a world publishing no hulls, so `Flight.setShip`
 * took its `powerMul: 1` fallback and the flown Kestrel cruised at 120 m/s -
 * a hull the wing could always out-run, which is what bounded the separation.
 *
 * Re-flown with the game's stock Kestrel (210 m/s) and `DISENGAGE` lifted out
 * of the way, the same case opens 11,015 m. So:
 *
 *   - the CONCLUSION stands, harder than before: a radius-based release is
 *     structurally wrong, and the radius it would have needed is 11 km rather
 *     than the 3.6 km originally claimed;
 *   - the DERIVATION of `DISENGAGE = 3600` does not. It is not "where a
 *     break-off tops out"; it is a tuning choice about how far you have to get
 *     before the wing loses interest, and with the real hull it lands INSIDE a
 *     break-and-reform cycle rather than past the end of one. That is a live
 *     design question and it has deliberately not been answered here.
 *
 * ── SO THE RELEASE IS A CLOCK, AND IT MEASURES THE RIGHT THING ─────────────
 *
 * You are held while the fight is on and something has had you recently.
 * "Recently" resets on either of two conditions, and both are needed:
 *
 *   IN REACH. Something is inside its own gun range. A hostile that is in
 *   range and missing is still shooting at you, so this is reach and not
 *   damage - a lock that only held while you were being hit would reward
 *   flying badly.
 *   OR STILL GAINING. The nearest is closing the range on you faster than
 *   5 m/s. This is the term that survives a break-and-reform: a craft that has
 *   overshot and is coming round again is not out of the fight, and the range
 *   readout cannot tell the difference on its own.
 *
 * Twelve seconds is set against the wing's own cycle: `BREAK_MAX` is 3.4 s and
 * a `REFORM` run is capped at 7, so a craft mid-cycle is out of reach for at
 * most about 10.4 s - and for most of that it is closing again, which resets
 * the clock anyway. Below ten the lock falls off between passes; much above
 * fifteen it stops being a release at all.
 *
 * What it costs, flown: a hull that can out-run the wing is free about twelve
 * seconds after it breaks contact. A hull that CANNOT - a stock Dray cruises
 * at 150 m/s against a skiff's 174 - is held until the wing loses interest.
 * Both are correct: you cannot outrun something faster than you, and the
 * answer to that is the gun.
 *
 * (This paragraph used to cite "the headless rig ... cruising at 120 m/s" and
 * a measured 67 s. That rig was flying a hull the game does not have - see the
 * note above on where 3,590 m came from - so the 67 s described nothing. The
 * Dray is the real hull that cannot out-run a skiff.)
 */
export const LOCK_GRACE = 12;
/**
 * How far past a zone's own trigger sphere an ARMED zone stays armed.
 *
 * A drive shedding 5,000 m/s to cruise over `transitSpoolDown` covers about
 * 3.1 km doing it, so a zone that disarmed at its own sphere edge would fire
 * the interdiction and then be coasted out of before the wing could launch -
 * the fly-through defect wearing a different hat. Six kilometres covers the
 * whole spool-down from the far side of the sphere with room to spare.
 */
export const ARM_LEASH = 6000;
/**
 * Furthest a contact may be and still be the LOCKED target - the one with the
 * lead pip and the name plate. 1,200 m: past the gun by enough that you can
 * line a merge up, short of the point where a pip on a 6 px speck is telling
 * you about something you cannot act on. Every live contact is still listed
 * and still has a marker at any range; this is only about which one the
 * gunnery solution is run for.
 */
export const TARGET_RANGE = 1200;
/**
 * The angular size, in radians, at which a hull stops needing a marker.
 *
 * The whole job of a contact pip is to make something FINDABLE while it is too
 * small to be legible - so it has to know when that stops being true, or it
 * spends the rest of the fight sitting on top of the one thing the player is
 * trying to look at. (It did: the first build drew a filled 12 px diamond, and
 * the screenshot at 300 m showed it covering a 25 px skiff.)
 *
 * 0.035 rad is 25 px at 1080p and 75 degrees vertical - `1080 / 1.5347` rows
 * per radian - and 25 px is where `.probe/engage/` shows the swept blades
 * separating from the body and the craft reading as a shape with a facing. It
 * is stated as an ANGLE and not as a range or a pixel count because it is the
 * only one of the three that is true on every screen and for every hull: a
 * lance is legible from 423 m and a skiff from 240 m, and neither number had
 * to be typed.
 */
export const LEGIBLE_ANGLE = 0.035;
/** Seconds before a cleared zone can fire again. */
export const REARM_CLEARED = 210;
/** ...and before one the player merely ran away from can. */
export const REARM_FLED = 45;

/** Bolts in flight, both sides. See the pool note in the header. */
const MAX_BOLTS = 128;
/** Sparks, flashes and debris. */
const MAX_FLARES = 260;
/** Salvage canisters floating at once. */
const MAX_SALVAGE = 8;
/** Hostiles alive at once, across every class. */
const MAX_HOSTILES = 6;
/** Metres. Fly this close to a canister and it is scooped. */
const SCOOP_RANGE = 60;
/** Seconds a canister drifts before it is lost. */
const SALVAGE_LIFE = 60;

/** Module-level scratch. HOUSE RULE: a frame handler allocates nothing. */
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _rel = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _prevDir = new THREE.Vector3();
/* The aim point of one bolt of the fan. `_v3` holds the fan's CENTRE for the
 * whole burst, so the per-bolt offset needs somewhere of its own to live - and
 * the house rule above says a frame handler allocates nothing. */
const _fanAim = new THREE.Vector3();
const _mtx = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scale = new THREE.Vector3();
const _col = new THREE.Color();
const _mouth = new THREE.Vector3(...DOCK_ANCHOR.mouth);
const _target = { position: new THREE.Vector3(), velocity: new THREE.Vector3(), jink: 0 };
const _FWD_Z = new THREE.Vector3(0, 0, 1);

const clamp = THREE.MathUtils.clamp;

export class SpaceCombat {
  /**
   * @param {{scene:THREE.Scene, camera:THREE.PerspectiveCamera, bus:any,
   *          input:any, player:any, worldManager:any, piloting:any,
   *          ships?:any, economy?:any, engine?:any, rnd?:()=>number}} ctx
   */
  constructor({
    scene, camera, bus, input, player, worldManager, piloting,
    ships = null, economy = null, engine = null, rnd = Math.random,
  }) {
    this.scene = scene;
    this.camera = camera ?? null;
    this.bus = bus ?? null;
    this.input = input ?? null;
    this.player = player ?? null;
    this.worldManager = worldManager ?? null;
    this.piloting = piloting ?? null;
    this.ships = ships ?? null;
    this.economy = economy ?? null;
    /* ONLY for `_buffNow`, and it is the whole reason it is here.
     *
     * `engine.simElapsed` is PLAY time: it stops while a UI panel holds
     * gameplay, and the panel that holds gameplay is the inventory sheet the
     * player uses the cell FROM. Dating the deadline off wall time would burn
     * a slice of the thirty seconds they just paid for while they were still
     * looking at the bag. Every other timed consumable in the game already
     * dates against this clock - see `Combat._buffNow` and the header of
     * `systems/ActiveEffects.js` - and the HUD chip counts down on it, so an
     * effect on a different clock would be an indicator that disagrees with
     * the thing it describes. */
    this.engine = engine ?? null;
    this.rnd = rnd;

    /** Everything this system draws hangs off one node, so it is one remove. */
    this.group = new THREE.Group();
    this.group.name = 'combat';
    scene?.add?.(this.group);

    /** @type {Map<string, object>} one model per class, shared by every craft. */
    this._models = new Map();
    /** @type {AlienShip[]} */
    this.hostiles = [];

    /** Zones published by the live world. Replaced on every world change. */
    this._zones = [];
    /** zone id -> seconds until it may fire again. */
    this._cool = new Map();
    /**
     * The zone whose trigger sphere has fired but whose wing has not launched
     * yet, because the player is still coming out of transit. Arming is what
     * writes `interdicted`; see the header. Null the rest of the time.
     * @type {object|null}
     */
    this._armed = null;
    /** Seconds since a hostile was last inside its own gun range. See `_locked`. */
    this._lockT = 0;

    /* Player state. */
    this.shield = 0;
    this.shieldMax = SHIELD_FLOOR;
    this.gunCharge = GUN.capacity;
    this._fireCool = 0;
    this._gunIdle = 0;
    /**
     * Bolts the gun lays down per shot, or 0 for the stock pair.
     * Raised by `setGunSpread`, cleared by `update` when the deadline passes.
     * @see setGunSpread
     */
    this._spreadBolts = 0;
    /** Seconds of `engine.simElapsed`. @see _buffNow */
    this._spreadUntil = 0;
    this._shieldIdle = 0;
    /** Seconds of screen flash left, and which kind. */
    this.hitFlash = 0;
    this.hitKind = 'shield';
    /** Radians/second the player's velocity direction is turning. */
    this.jink = 0;
    /** False until `_readTarget` has one previous heading to difference. */
    this._hasPrev = false;
    /** @type {AlienShip|null} */
    this.target = null;
    /** Seconds the "contacts" banner stays up. */
    this.warn = 0;
    this._warnText = '';
    /** Which rung of `_hullAlarm` is up, and the countdown to its repeat. */
    this._hullRung = null;
    this._hullSince = 0;

    /** Tallies. Read by the HUD, the tests and the trip report. */
    this.stats = { kills: 0, shotsFired: 0, shotsHit: 0, bounty: 0, taken: 0, salvaged: 0 };
    /** The zone currently being fought, or null. */
    this.zone = null;

    this._buildBolts();
    this._buildFlares();
    this._buildSalvage();
    this._chargeShield();

    /* Screen-space aim marks, published as NDC so the HUD can stay a HUD.
     * `on` is false when the point is behind the camera or off the plate. */
    this.aim = { x: 0, y: 0, on: false };
    this.lead = { x: 0, y: 0, on: false, range: 0 };
    /**
     * One row per live hostile, in the same shape `Piloting.navReport` fills.
     *
     * POOLED, and `navReport`'s precedent is deliberately not followed here.
     * That method pushes a fresh object literal per body, which is right for
     * it - it runs at 5 Hz behind the HUD's own timer, because a body 245 km
     * away moves 91 m in a frame. A contact's BEARING sweeps a whole quadrant
     * in a turn, so this list has to be read at frame rate, and six object
     * literals and six nested `ndc` objects sixty times a second is 720
     * allocations a second inside a fight - against this file's own house rule
     * that a frame handler allocates nothing. The rows are therefore built
     * once and filled in place; `contactReport` hands out references to them.
     * @type {Array<object>}
     */
    this._pool = [];
    for (let i = 0; i < MAX_HOSTILES; i++) {
      this._pool.push({
        name: '', kind: 'hostile', range: 0, frac: 0, locked: false, inRange: false, legible: false,
        ahead: 0, above: 0, right: 0, closing: 0,
        ndc: { x: 0, y: 0, on: false }, edge: false,
      });
    }
    /** The array `contactReport` fills when the caller does not supply one. */
    this._contacts = [];

    /* A HULL LEAVES THE YARD WITH ITS SHIELDS UP.
     *
     * `_regen` sizes the pool from the tier every step and preserves the
     * FRACTION when the ceiling moves, which is right for an upgrade bought
     * mid-session and wrong for the very first step of a session: the pool
     * starts at zero, the fraction is therefore zero, and the player launches
     * naked and spends eleven seconds regenerating. Measured before this: the
     * shield read 0% at t = 0.0 s on every flight. */
    this._offBoard = bus?.on?.('pilot:boarded', () => this._chargeShield());
    this._offWorld = bus?.on?.('world:changed', () => this._adopt());
    /* Leaving the seat ends the fight. Dying in it does too - `Piloting._onDied`
     * flies the hull home, and hostiles left circling an empty patch of sky
     * would still be there when the player launched again. */
    this._offLeft = bus?.on?.('pilot:left', () => this.standDown('left'));
    this._offTravel = bus?.on?.('pilot:travelling', () => this.standDown('travel'));
    this._adopt();
  }

  /* ================================================================== */
  /* Published surface                                                   */
  /* ================================================================== */

  /** True while at least one hostile is alive. */
  get engaged() {
    for (const h of this.hostiles) if (h.alive) return true;
    return false;
  }

  /** How many are alive right now. */
  get contacts() {
    let n = 0;
    for (const h of this.hostiles) if (h.alive) n++;
    return n;
  }

  /** The hull the player is flying, as the two tiers that matter. */
  tiers(shipId = this.piloting?.shipId) {
    const base = SHIP_BASE_STATS[shipId] ?? {};
    const bought = this.ships?.getPowers?.(shipId) ?? {};
    const t = (k) => Math.max(0, Math.floor(Number(bought?.[k]) || 0));
    return {
      fire: (base.fire ?? 0) + t('fire'),
      shield: (base.shield ?? 0) + t('shield'),
    };
  }

  /** Damage one of the player's bolts does. The panel's own 15% per tier. */
  boltDamage(shipId = this.piloting?.shipId) {
    return GUN.damage * (1 + (SHIP_STAT_META.fire.perTier / 100) * this.tiers(shipId).fire);
  }

  /* ------------------------------------------------------------------ */
  /* Wide dispersal                                                      */
  /* ------------------------------------------------------------------ */

  /**
   * THE BUFF CLOCK: seconds of gameplay, from the engine.
   *
   * Byte for byte `Combat._buffNow`, and deliberately so. `engine.simElapsed`
   * is the one clock every timed consumable in the game dates its deadline
   * from, and it is the clock `systems/ActiveEffects.js` counts the HUD chip
   * down on - so the chip and the effect it describes cannot disagree. Wall
   * time would run while the inventory sheet that spent the cell was still
   * open, which is a slice of the player's thirty seconds spent on nothing.
   *
   * @returns {number} seconds
   */
  _buffNow() {
    return this.engine?.simElapsed ?? 0;
  }

  /**
   * Bolts the next shot will lay down, or 0 while the gun is stock.
   *
   * Read by `_playerGun` and by the tests. It is the raw field rather than a
   * deadline comparison on purpose: `update()` is the ONE place that decides
   * the effect has ended, exactly as `Combat.update` is for the damage boost.
   * A getter that re-derived it here would be a second opinion about the same
   * number, and this file's own `_locked` note is about what happens when two
   * places describe one fact.
   */
  get spreadBolts() {
    return this._spreadBolts;
  }

  /**
   * Is there a gun to widen right now?
   *
   * Asked by `ItemUse._canApply` BEFORE the cell is taken out of the bag, so a
   * cell used on foot is refused and KEPT. That is the whole reason this is
   * public.
   *
   * `_playable()` is the same predicate that gates `_playerGun` itself - a
   * live seat, not mid-seam, not landed, and in `space`, which is the only
   * world that publishes encounters and therefore the only world the gun ever
   * fires in. Asking the same question both places means "can I widen the
   * guns" and "is there a gun running" cannot drift apart; a looser test here
   * would let a player spend a cell while walking round the yard and get
   * thirty seconds of an effect on a weapon that is not in their hands.
   *
   * The `shipId` term is the honest half of "there is a hull": `piloting.flight`
   * is a `Flight` instance from the moment `Piloting` is constructed and is
   * never null, so testing it would be testing that the constructor ran.
   * `shipId` is null until `board()` and is what `_playerGun` reads to size the
   * muzzle span.
   *
   * @returns {boolean}
   */
  canWidenGuns() {
    return this._playable() && !!this.piloting?.shipId;
  }

  /**
   * Run the wide-dispersal fan for `duration` seconds.
   *
   * Shaped on `Combat.boostPlayerDamage` deliberately, down to the refusals:
   * a non-positive or non-finite argument is not an effect, and a second
   * charge on a running one EXTENDS it (`Math.max` on both fields) rather than
   * replacing it. `ActiveEffects.start` raises one chip per kind and moves its
   * deadline forward the same way, so a player who burns two cells sees one
   * chip with a longer clock rather than two chips for one gun.
   *
   * `bolts` is snapped UP to an EVEN number and floored at 4, and both halves
   * of that are the geometry rather than tidiness. Even because the fan is the
   * stock pair plus symmetric rings hung either side of it - `(bolts - 2) / 2`
   * rings a side - so an odd count has nowhere to put the spare except on the
   * axis, and a bolt on the axis is a third permanent hit on an on-pip target:
   * a flat x1.5 damage buff nobody asked for. Four because two IS the gun the
   * player already has, and an "effect" that grants it is not an effect.
   *
   * @param {number} duration seconds of play time
   * @param {number} [bolts] bolts per shot, counting the two core bolts
   * @returns {boolean} false if nothing was applied
   */
  setGunSpread(duration, bolts = FAN_BOLTS) {
    if (!(duration > 0) || !Number.isFinite(duration)) return false;
    const asked = Math.floor(Number(bolts));
    if (!Number.isFinite(asked) || asked < 4) return false;
    const even = asked % 2 === 0 ? asked : asked + 1;
    this._spreadBolts = Math.max(this._spreadBolts, even);
    this._spreadUntil = Math.max(this._spreadUntil, this._buffNow() + duration);
    return true;
  }

  /**
   * Is there a shield to recharge right now?
   *
   * `canWidenGuns()` directly above, plus one term. Asked by
   * `ItemUse._canApply` BEFORE the cell is taken out of the bag, so a cell used
   * on the concourse is refused and KEPT - the same contract, for the same
   * reason, as the laser cell it sits beside on the yard shelf.
   *
   * ── THE EXTRA TERM, AND WHY IT IS AN INEQUALITY AND NOT A THRESHOLD ───────
   * `shield < shieldMax` refuses a cell that would put nothing anywhere: a full
   * pool cannot absorb a charge, so spending the unit on one is the
   * unit-destroyed-for-nothing failure this file's neighbours keep naming.
   *
   * It is deliberately NOT "the shield is low enough to be worth a cell".
   * `_apply` clamps the charge to what fits, so a pilot one point down gets one
   * point back and keeps nothing else - a partial grant, which is real value,
   * and refusing it would be the mirror failure the bag rigs record at 59 of 60
   * slots: a unit WITHHELD for nothing. The player decides when a cell is worth
   * spending; this only refuses the case where it cannot be.
   *
   * @returns {boolean}
   */
  canChargeShield() {
    return this._playable() && !!this.piloting?.shipId && this.shield < this.shieldMax;
  }

  /**
   * Put `amount` back into the absorption pool, up to its ceiling.
   *
   * Shaped on `setGunSpread` above deliberately, down to the refusals: a
   * non-positive or non-finite argument is not an effect, and the method
   * answers with what it DID rather than with what it was asked for.
   *
   * ── IT WRITES THE SHIELD THE WAY `_chargeShield` DOES ─────────────────────
   * Clamped to `shieldMax` and followed by `_shieldIdle = SHIELD_DELAY`, which
   * is the second half of the item and not a tidy-up. `_playerHit` zeroes that
   * counter on every hit and `_regen` only tops the pool up once it has passed
   * `SHIELD_DELAY`, so a cell that only wrote `shield` would hand the pilot the
   * charge and leave them still locked out of their own regeneration for four
   * and a half seconds of the fight. Setting it to the delay means the pool
   * starts trickling back on the very next step, exactly as it does when a hull
   * is boarded, and the next hit re-locks it exactly as it always did.
   *
   * NO DEADLINE AND NO CHIP. This is instantaneous the way `Player.heal` is -
   * it changes a number once and there is nothing left running to count down -
   * so it is absent from `ActiveEffects.EFFECT_KINDS` for the reason `heal`
   * is. @see ../systems/ActiveEffects.js
   *
   * @param {number} [amount] points of shield to restore
   * @returns {number} points actually restored, 0 if nothing was
   */
  chargeShield(amount = SHIELD_CELL_CHARGE) {
    const asked = Number(amount);
    if (!(asked > 0) || !Number.isFinite(asked)) return 0;
    const room = this.shieldMax - this.shield;
    if (!(room > 0)) return 0;
    const put = Math.min(room, asked);
    this.shield += put;
    this._shieldIdle = SHIELD_DELAY;
    return put;
  }

  /**
   * EVERY LIVE HOSTILE, AS A BEARING AND A RANGE. The findability half.
   *
   * A skiff at 780 m is ten pixels and at 1,250 m it is five, and no amount of
   * emissive fixes that - so past the range where a contact is LEGIBLE it has
   * to be FINDABLE instead, and findable means a bearing you can steer on and
   * a number you can act on. That is exactly what `Piloting.navReport` already
   * publishes for the planets, so this fills the SAME SHAPE rather than
   * inventing a second one: `FlightHUD` draws these rows with the same
   * `arrow()` glyph, the same `range()` formatter and the same `.row` markup
   * it draws Cinder with, and the only difference is a class name.
   *
   * `ahead` / `above` / `right` are all three signed dots, for the reason
   * `navReport` gives at length: two of them cannot say which way to turn.
   *
   * `ndc` is the extra a planet does not need. A body 245 km away is a marker
   * on a list; a hostile 400 m away is a thing you have to put your nose on
   * this second, so it also gets a screen position - and one that is CLAMPED
   * to the plate with `edge` set when the contact is off it or astern, which
   * is what turns "somewhere behind you" into an arrow you can fly.
   *
   * NOTHING HERE DIVIDES BY A VELOCITY. `closing` is a dot product; the time
   * it would take to close is deliberately not published, because a zero
   * relative velocity is a real case in a co-speed turning fight and this
   * project has already lost a day to 19 NaN pixels through `UnrealBloomPass`
   * blacking out a 921,600-pixel frame. Every number below is finite by
   * construction and `_project` refuses to publish one that is not.
   *
   * @param {Array<object>} [out] filled in place; the caller owns it.
   */
  contactReport(out = null) {
    const rows = out ?? this._contacts;
    rows.length = 0;
    const p = this.piloting;
    if (!p?.active || !this._playable()) return rows;
    const f = p.flight;
    f.forward(_fwd);
    f.up(_up);
    f.right(_right);
    let n = 0;
    for (const h of this.hostiles) {
      if (!h.alive || n >= this._pool.length) continue;
      const row = this._pool[n++];
      const range = h.position.distanceTo(f.position);
      _v.copy(h.position).sub(f.position);
      /* A hostile exactly on the camera is a can't-happen (the hit spheres
       * would have met first) and it is still written down, because
       * `normalize()` on a zero vector leaves a zero vector and every dot
       * below would then be 0 rather than NaN - which is a wrong glyph, not a
       * black frame, but it is still wrong. Dead ahead is the honest answer
       * for something you are inside. */
      const near = range < 1e-3;
      if (!near) _v.divideScalar(range);
      row.name = h.name;
      row.range = range;
      /** 0..1 integrity, for the bar. */
      row.frac = h.healthFrac;
      /** True for the one the lead pip is solving for. */
      row.locked = h === this.target;
      /** Is it close enough to shoot at right now? */
      row.inRange = range <= GUN.range;
      /* Big enough on the plate to be its own marker. `2 * radius` is the hit
       * sphere the rest of this file already uses as the hull's size, and the
       * guard is the near case: something you are inside subtends everything. */
      row.legible = near || (2 * h.radius) / range > LEGIBLE_ANGLE;
      row.ahead = near ? 1 : _v.dot(_fwd);
      row.above = near ? 0 : _v.dot(_up);
      row.right = near ? 0 : _v.dot(_right);
      /** Closing speed, m/s, positive when the range is shortening. */
      row.closing = near ? 0 : _v.dot(_v2.copy(f.velocity).sub(h.velocity));
      /** True when `ndc` had to be pinned to the plate to be drawable. */
      row.edge = false;
      this._project(h.position, row.ndc);
      /* OFF THE PLATE IS THE CASE THAT MATTERS. `_project` reports `on: false`
       * for anything behind the camera or outside the frame, and a marker that
       * simply vanishes there is a marker that disappears at exactly the
       * moment a pilot needs it. So the direction is re-derived from the
       * BEARING - which is always valid - and pinned to the edge. */
      if (!row.ndc.on) {
        row.edge = true;
        let ex = row.right;
        let ey = row.above;
        const m = Math.hypot(ex, ey);
        if (m > 1e-4) { ex /= m; ey /= m; } else { ex = 0; ey = -1; }
        row.ndc.x = ex;
        row.ndc.y = ey;
        row.ndc.on = true;
      }
      rows.push(row);
    }
    rows.sort((a, b) => a.range - b.range);
    return rows;
  }

  /** Everything the flight HUD draws, in one read. Fills a caller's object. */
  report(out = {}) {
    out.engaged = this.engaged;
    out.contacts = this.contacts;
    /* Whether the transit drive is being denied, and by what. Published so the
     * HUD can say "you are held" and, more usefully, stop saying it the
     * instant the player has opened the range - which is the whole of how you
     * get away. */
    out.locked = !!this.piloting?.interdicted;
    /* Seconds of "clear" still to run before the drive is yours, or null when
     * something has you right now. This is the countdown the HUD draws, and it
     * is the whole of teaching the mechanic: a number that ticks down while
     * you hold a heading is a rule a player can learn in one encounter. */
    out.lockIn = this._armed || this._lockT <= 0
      ? null
      : Math.max(0, LOCK_GRACE - this._lockT);
    out.lockGrace = LOCK_GRACE;
    out.shield = this.shield;
    out.shieldMax = this.shieldMax;
    out.shieldFrac = this.shieldMax > 0 ? this.shield / this.shieldMax : 0;
    out.gun = GUN.capacity > 0 ? this.gunCharge / GUN.capacity : 0;
    out.hitFlash = this.hitFlash;
    out.hitKind = this.hitKind;
    out.warn = this.warn;
    out.warnText = this._warnText;
    out.kills = this.stats.kills;
    out.bounty = this.stats.bounty;
    out.aim = this.aim;
    out.lead = this.lead;
    const t = this.target;
    const f = this.piloting?.flight ?? null;
    out.target = t && t.alive && f
      ? {
        name: t.name,
        range: t.position.distanceTo(f.position),
        frac: t.healthFrac,
        state: t.state,
      }
      : null;
    return out;
  }

  /* ================================================================== */
  /* Fixed step                                                          */
  /* ================================================================== */

  /**
   * Runs AFTER `piloting.fixedUpdate`, because every hostile leads its shots
   * against the position the player's integrator wrote THIS step. Reading last
   * step's position at a 455 m/s closure is a 7.6 m aiming error handed to the
   * enemy for free, in the player's favour on approach and against them on
   * separation - which is the worst kind of bug, because it makes the fight
   * inconsistent rather than merely wrong.
   */
  fixedUpdate(dt, elapsed) {
    const live = this._playable();

    this.hitFlash = Math.max(0, this.hitFlash - dt);
    this.warn = Math.max(0, this.warn - dt);
    if (live) this._hullAlarm(dt);

    if (live) {
      this._readTarget(dt);
      this._regen(dt);
      this._playerGun(dt);
      this._steps(dt, elapsed);
      this._stepBolts(dt, true);
      this._stepSalvage(dt);
      this._spawner(dt);
      this._retarget();
    } else if (this.hostiles.length) {
      this._stepBolts(dt, false);
    }

    /* THE HOOK INTO TRANSIT, AND IT IS WRITTEN LAST ON PURPOSE.
     *
     * `main.js` runs `piloting.fixedUpdate` BEFORE this, so the flag piloting
     * reads is always the one written at the end of the previous step. Writing
     * it at the TOP of this method - which the first version did - meant it
     * described the state before `_spawner` had run, so on the step a wing
     * launched the flag still said "clear" and the ship covered one more step
     * at eight times speed. Written here it is the freshest fact available to
     * the next step, and the stale window is gone.
     *
     * It is also cleared the step the last hostile dies, so a cleared field
     * lets the player leave at transit immediately rather than after a timer.
     *
     * ── AND IT IS A CLOCK NOW, NOT A FLAG ───────────────────────────────────
     * `live && this.engaged` meant "anything is alive anywhere", and combined
     * with `DISENGAGE` at 3,600 m that denied the drive for about ninety
     * seconds after a player had broken off - most of them spent out of the
     * hostiles' 420 m gun, flying straight, not being shot at, and unable to
     * leave. That is being pinned by bookkeeping. `_locked` makes breaking the
     * lock a thing the player DOES: get clear of their guns, stop being gained
     * on, hold it for `LOCK_GRACE`. The armed-zone term is what interdicts you
     * BEFORE the wing exists, which is the whole of the fly-through fix. */
    if (this.piloting) this.piloting.interdicted = live && (!!this._armed || this._locked(dt));
  }

  /**
   * Does anything still have a lock? Two conditions, and BOTH must hold.
   *
   *   IN REACH. Something is inside its own gun range right now.
   *   OR GAINING. The nearest is closing the range faster than 5 m/s.
   *
   * Either resets the clock; twelve seconds of neither releases the drive.
   *
   * The clock is reset by REACH and not by damage on purpose. A hostile that
   * is in range and missing is still shooting at you, and a lock that only
   * held while you were being hit would reward flying badly.
   *
   * ── AND IT IS ALSO RESET BY ANYTHING STILL CLOSING ────────────────────────
   * "Out of reach" alone was not enough, and `space-objectives.test.mjs` is
   * what said so: a wing's own cycle - `BREAK_MAX` 3.4 s, then a REFORM run
   * capped at 7, then however long the INTERCEPT takes to get back inside
   * 420 m - can legitimately keep every craft out of range for well over
   * twelve seconds while the fight is very much still on. With reach as the
   * only reset the guns-cold ablation shook a three-craft wing inside sixty
   * seconds of doing nothing at all, which is a fight ending itself.
   *
   * So the clock only runs while nothing can shoot you AND nothing is gaining
   * on you. That is the honest reading of "they have lost me", it is a
   * statement about both craft rather than about a radius, and it is why a
   * slower hull cannot use it: if they can still close, you have not escaped.
   */
  _locked(dt) {
    const p = this.piloting?.flight?.position;
    const v = this.piloting?.flight?.velocity;
    if (!p || !v) { this._lockT = LOCK_GRACE; return false; }
    /* No fight, no lock. `DISENGAGE` is the outer bound and it is already
     * enforced by `_spawner`, which stands the wing down at 3,600 m - so
     * "engaged" is the range test, and duplicating it here as a second radius
     * is exactly the mistake documented on `LOCK_GRACE`. */
    let nearest = Infinity;
    let inReach = false;
    let gaining = false;
    for (const h of this.hostiles) {
      if (!h.alive) continue;
      const d = h.position.distanceTo(p);
      if (d < nearest) nearest = d;
      if (d <= h.def.range) inReach = true;
      /* Rate of change of the range, as one dot: the hostile's velocity
       * relative to ours, along the line from it to us. Positive means the gap
       * is shrinking. No division - `d` is only used to normalise and the
       * degenerate `d === 0` is skipped, because a hostile at zero range is
       * not a question about whether it is catching up. */
      if (d > 1e-3) {
        _v.copy(p).sub(h.position).divideScalar(d);
        if (_v.dot(_v2.copy(h.velocity).sub(v)) > 5) gaining = true;
      }
    }
    /* Nothing alive: the clock is meaningless and is parked at zero so the
     * next wing starts with its full grace rather than with the last one's
     * leftovers. */
    if (!Number.isFinite(nearest)) { this._lockT = 0; return false; }
    this._lockT = (inReach || gaining) ? 0 : this._lockT + dt;
    return this._lockT < LOCK_GRACE;
  }

  /** Is there a ship, flying, in the void, not mid-seam? */
  _playable() {
    const p = this.piloting;
    if (!p?.active || p._travelling) return false;
    if (p.landed) return false;
    return (this.worldManager?.active?.id ?? null) === 'space';
  }

  /**
   * The target struct every hostile aims at, plus the jink measurement their
   * accuracy is degraded by.
   *
   * `jink` is the rate at which the velocity DIRECTION is turning, normalised
   * against the player's own best turn rate so 1.0 means "pulling as hard as
   * this hull can". Measured off the real integrator rather than off the
   * command struct on purpose: a player who holds full pitch while pointing
   * straight at a planet at 40 m/s is not jinking, whatever the stick says.
   */
  _readTarget(dt) {
    const f = this.piloting.flight;
    _target.position.copy(f.position);
    _target.velocity.copy(f.velocity);
    const sp = f.velocity.length();
    if (sp > 1 && dt > 0) {
      _v.copy(f.velocity).divideScalar(sp);
      if (this._hasPrev) {
        const dot = clamp(_v.dot(_prevDir), -1, 1);
        const rate = Math.acos(dot) / dt;
        /* Damped, because a single step's arccos is noisy near zero and a
         * hostile whose aim flickers frame to frame reads as a bug. */
        this.jink += (clamp(rate / 1.4, 0, 1) - this.jink) * Math.min(1, dt * 6);
      }
      _prevDir.copy(_v);
      this._hasPrev = true;
    } else {
      this.jink += (0 - this.jink) * Math.min(1, dt * 6);
    }
    _target.jink = this.jink;
  }

  /* ------------------------------------------------------------------ */
  /* The player's gun                                                    */
  /* ------------------------------------------------------------------ */

  _playerGun(dt) {
    this._fireCool = Math.max(0, this._fireCool - dt);
    this._gunIdle += dt;
    if (this._gunIdle > GUN.regenDelay) {
      this.gunCharge = Math.min(GUN.capacity, this.gunCharge + GUN.regen * dt);
    }

    const inp = this.input;
    if (!inp || inp.textCaptured) return;
    if (!inp.state?.fire) return;
    if (this._fireCool > 0 || this.gunCharge < GUN.cost) return;

    this._fireCool = GUN.interval;
    this.gunCharge -= GUN.cost;
    this._gunIdle = 0;

    const f = this.piloting.flight;
    f.forward(_fwd);
    f.right(_right);
    f.up(_up);
    /* -- WHERE THE GUNS POINT, AND THE DRAY THAT COULD NOT HIT ANYTHING ------
     *
     * The first version put a muzzle at each wingtip firing PARALLEL to the
     * nose, on the argument that parallel guns make the reticle true at every
     * range. It does - and on the Dray it made the gun useless. A 28 m ore
     * tender has a 6.16 m half-span at `length * 0.22`, so its two bolts
     * straddle a 4.2 m skiff sitting dead on the crosshair and both miss, at
     * every range, forever. The case that found it fired forty shots at a
     * stationary target 200 m dead ahead and did no damage at all.
     *
     * Two changes, and both are needed:
     *
     *   CONVERGENCE. The bolts are aimed at a point `CONVERGE` metres up the
     *   nose line, which is the SAME point `_drawAim` projects the reticle to.
     *   The crosshair is therefore exact exactly where the guns cross, which
     *   is the honest version of what parallel guns were meant to buy.
     *
     *   A CAP ON THE SPAN. Convergence alone still spreads at close range - at
     *   100 m a 6.16 m span is still 5 m off the axis - so the span is capped
     *   at `MAX_SPAN`. Past that the guns move in from the wingtips toward the
     *   chin, which is where a heavy hauler would carry them anyway.
     *
     * The span comes from `SHIP_CLASSES[...].length`, public catalogue data.
     * The flown model's own radius is on `Piloting._model`, and reading a
     * private field to place a muzzle is how two descriptions of one ship
     * start to drift.
     *
     * ── AND THE LOOP NOW HANGS RINGS OFF THAT PAIR, WITHOUT MOVING IT ────
     *
     * Wide dispersal (`setGunSpread`, bought with a `laser_cell`) leaves every
     * word above not merely true but LOAD-BEARING: the two bolts described
     * there are still fired, still from the capped span, still aimed at the
     * convergence point, and they are what guarantees that turning the effect
     * on can never cost the player damage on the craft in their crosshair. The
     * extra bolts are hung outboard of them by walking the AIM POINT - and only
     * the aim point - out in steps of `FAN_PITCH`.
     *
     * That makes `rings = 0` the stock gun EXACTLY rather than approximately:
     * the inner loop runs once per side with a zero offset, which is the two
     * lines this method has always had. The eight-bolt case, the table of
     * off-axis error that sizes `FAN_PITCH`, and the single-target invariant
     * are all in the `FAN_BOLTS` note at the top of this file, because a change
     * to gun geometry without the arithmetic written down is precisely what put
     * the Dray in the paragraph above. */
    const len = SHIP_CLASSES[this.piloting.shipId]?.length ?? 14;
    const span = Math.min(len * 0.22, MAX_SPAN);
    const dmg = this.boltDamage();
    /* Damage per bolt is NOT scaled by the fan, and now it must not be. The
     * core pair is the stock gun, so a scale-down here would put single-target
     * output BELOW the unmodified weapon - the exact defect this arrangement
     * was rebuilt to remove. See `FAN_BOLTS`. */
    const rings = this._spreadBolts > 0 ? (this._spreadBolts - 2) / 2 : 0;
    _v3.copy(f.position).addScaledVector(_fwd, CONVERGE);
    for (let s = -1; s <= 1; s += 2) {
      /* One muzzle per side, shared by that side's whole comb. A ring is a
       * different aim, not a different gun port. */
      _v.copy(f.position).addScaledVector(_right, span * s).addScaledVector(_up, -0.6);
      for (let k = 0; k <= rings; k++) {
        _fanAim.copy(_v3).addScaledVector(_right, FAN_PITCH * k * s);
        _v2.copy(_fanAim).sub(_v).normalize();
        this._spawnBolt(_v, _v2, GUN.speed, dmg, GUN.range, 0);
      }
      /* ONE bloom per muzzle, outside the ring loop. A ring is a different
       * aim, not a different gun port - all of a side's bolts leave the same
       * `_v`. Spawning the flare per BOLT put four coincident additive sprites
       * on one point while the fan was up: the material is AdditiveBlending
       * with toneMapped false, so the authored (0.7, 3.2, 4.2) summed to
       * (2.8, 12.8, 16.8) before bloom and reinstated, in intensity, exactly
       * the firework this note records cutting down.
       *
       * The muzzle bloom, and both numbers in it were wrong first time.
       *
       * It was 1.9 m across for 0.09 s in (2.4, 0.32, 3.4) - and (2.4, 0.32,
       * 3.4) is MAGENTA, which matched nothing on either side of the fight
       * and looked like a bug; at 1.9 m, sitting on the wingtips of a hull
       * that fills the middle of the chase view, two of them covered a third
       * of the plate every fifth of a second. Screenshotted, and
       * unmistakable.
       *
       * It is now the bolt's own cyan at a fifth the size and a shorter
       * life: a spark where the gun is, not a firework. */
      /* Along the CORE bolt (k = 0), not whichever ring the loop happened to
       * leave in `_v2`. The outermost ring is about 5 degrees off the nose,
       * and a bloom that leans is a bloom that reads as the gun being
       * mis-aimed. This is the direction the flare had before there were
       * rings at all. */
      _fanAim.copy(_v3);
      _v2.copy(_fanAim).sub(_v).normalize();
      this._flare(_v, _v2, 0.62, 0.055, 0.7, 3.2, 4.2, 26);
    }
    this.stats.shotsFired++;
    this.bus?.emit?.('combat:fire', {
      position: f.position, ship: this.piloting.shipId, bolts: 2 * (rings + 1),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Hostiles                                                            */
  /* ------------------------------------------------------------------ */

  _steps(dt, elapsed) {
    const fire = this._alienFire;
    for (let i = 0; i < this.hostiles.length; i++) {
      this.hostiles[i].fixedUpdate(dt, elapsed, _target, fire);
    }
  }

  /* Bound once in the constructor's stead - an arrow property, so the callback
   * handed to every craft every step is one function and not a closure made
   * sixty times a second. */
  _alienFire = (from, dir, ship) => {
    this._spawnBolt(from, dir, ship.def.boltSpeed, ship.def.damage, ship.def.range * 1.25, 1, ship);
    this._flare(from, dir, 1.5, 0.08, 3.2, 0.42, 0.18, 14);
    this.bus?.emit?.('combat:enemyFire', { position: from, classId: ship.classId });
  };

  /** Nearest live hostile, sticky, biased to the one you are pointing at. */
  _retarget() {
    const f = this.piloting.flight;
    f.forward(_fwd);
    const cur = this.target;
    if (cur?.alive) {
      const d = cur.position.distanceTo(f.position);
      _v.copy(cur.position).sub(f.position);
      if (d < TARGET_RANGE && (d < 1e-3 || _v.normalize().dot(_fwd) > 0.35)) return;
    }
    let best = null;
    let bestScore = -Infinity;
    for (const h of this.hostiles) {
      if (!h.alive) continue;
      const d = h.position.distanceTo(f.position);
      if (d > TARGET_RANGE) continue;
      _v.copy(h.position).sub(f.position);
      const ahead = d > 1e-3 ? _v.normalize().dot(_fwd) : 1;
      /* Ahead beats near: the thing you are pointing at is the thing you want
       * a range readout for, and a hostile 200 m behind you is not one you can
       * do anything about this second. */
      const score = ahead * 2 - d / TARGET_RANGE;
      if (score > bestScore) { bestScore = score; best = h; }
    }
    this.target = best;
  }

  /* ------------------------------------------------------------------ */
  /* Bolts                                                               */
  /* ------------------------------------------------------------------ */

  _buildBolts() {
    /* One box, stretched along +Z per instance and pointed down the velocity.
     * A box and not a cylinder: at these speeds a bolt is 12 m of streak
     * covering four pixels of width, and eight vertices draw it exactly as
     * well as forty-eight. */
    this._boltGeo = new THREE.BoxGeometry(1, 1, 1);
    this._boltMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, fog: false, toneMapped: false,
    });
    this._boltMesh = new THREE.InstancedMesh(this._boltGeo, this._boltMat, MAX_BOLTS);
    this._boltMesh.name = 'combat:bolts';
    this._boltMesh.frustumCulled = false;
    this._boltMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    /* `setColorAt` once with anything at all is what creates `instanceColor`;
     * doing it here means the attribute exists before the first frame and the
     * material's program is compiled with it. Allocating it lazily on the
     * first shot would relink the shader in the middle of a firefight. */
    for (let i = 0; i < MAX_BOLTS; i++) this._boltMesh.setColorAt(i, _col.setRGB(0, 0, 0));
    this.group.add(this._boltMesh);

    const N = MAX_BOLTS;
    this._b = {
      px: new Float32Array(N), py: new Float32Array(N), pz: new Float32Array(N),
      vx: new Float32Array(N), vy: new Float32Array(N), vz: new Float32Array(N),
      life: new Float32Array(N),
      dmg: new Float32Array(N),
      /** 0 = the player's, 1 = a hostile's. */
      side: new Uint8Array(N),
      active: new Uint8Array(N),
      /** Who fired it, so a hit can be credited. */
      owner: new Array(N).fill(null),
    };
    this._boltCount = 0;
    this._boltHead = 0;
  }

  _spawnBolt(origin, dir, speed, damage, range, side, owner = null) {
    const b = this._b;
    let slot = -1;
    for (let k = 0; k < MAX_BOLTS; k++) {
      const i = (this._boltHead + k) % MAX_BOLTS;
      if (b.active[i] === 0) { slot = i; break; }
    }
    /* Saturated. Drop the NEWEST shot rather than recycling a live one:
     * a bolt that vanishes mid-flight is a hit the player watched not happen,
     * and a shot that was never drawn is one they never saw. With 128 slots
     * and the cadences in `ALIEN_CLASSES` this cannot be reached by the
     * authored wings; it is here so that it cannot be reached by a future one
     * either. */
    if (slot < 0) return -1;
    this._boltHead = (slot + 1) % MAX_BOLTS;

    b.px[slot] = origin.x; b.py[slot] = origin.y; b.pz[slot] = origin.z;
    b.vx[slot] = dir.x * speed; b.vy[slot] = dir.y * speed; b.vz[slot] = dir.z * speed;
    b.life[slot] = range / speed;
    b.dmg[slot] = damage;
    b.side[slot] = side;
    b.owner[slot] = owner;
    b.active[slot] = 1;
    this._boltCount++;
    return slot;
  }

  /**
   * Integrate every bolt and resolve the segment it is about to cross.
   *
   * SWEPT, and the reasoning is `Projectiles`': at 1,600 m/s a fixed step is
   * 26.7 m of travel and a skiff is 4.2 m across, so a point test at the new
   * position would pass through six hostiles out of seven. The test is
   * segment-versus-sphere, closed form, no allocation:
   *
   *   solve |A + t(B-A) - C|^2 = r^2 for the smallest t in [0,1]
   *
   * @param {boolean} armed false while the player is not flying - bolts still
   *   fly and expire so a fight left behind does not freeze mid-air, but
   *   nothing can be hit by them.
   */
  _stepBolts(dt, armed) {
    if (this._boltCount === 0) return;
    const b = this._b;
    const shipPos = armed ? this.piloting.flight.position : null;
    const shipR = armed ? this._playerRadius() : 0;

    for (let i = 0; i < MAX_BOLTS; i++) {
      if (b.active[i] === 0) continue;
      b.life[i] -= dt;
      if (b.life[i] <= 0) { this._killBolt(i); continue; }

      _v.set(b.px[i], b.py[i], b.pz[i]);
      _seg.set(b.vx[i] * dt, b.vy[i] * dt, b.vz[i] * dt);
      _v2.copy(_v).add(_seg);

      let hitT = 2;
      let hitShip = null;
      if (armed) {
        if (b.side[i] === 0) {
          for (const h of this.hostiles) {
            if (!h.alive) continue;
            const t = this._sweep(_v, _seg, h.position, h.radius);
            if (t >= 0 && t < hitT) { hitT = t; hitShip = h; }
          }
        } else if (shipPos) {
          const t = this._sweep(_v, _seg, shipPos, shipR);
          if (t >= 0 && t < hitT) { hitT = t; hitShip = 'player'; }
        }
      }

      if (hitT <= 1) {
        _v3.copy(_v).addScaledVector(_seg, hitT);
        if (hitShip === 'player') this._playerHit(b.dmg[i], _v3, b.owner[i]);
        else this._hostileHit(hitShip, b.dmg[i], _v3);
        this._killBolt(i);
        continue;
      }

      b.px[i] = _v2.x; b.py[i] = _v2.y; b.pz[i] = _v2.z;
    }
  }

  /**
   * Smallest t in [0,1] at which the segment `from + t*seg` first enters the
   * sphere, or -1. Returns 0 when the segment starts inside it.
   */
  _sweep(from, seg, centre, radius) {
    _rel.copy(from).sub(centre);
    const a = seg.lengthSq();
    if (a < 1e-12) return _rel.lengthSq() <= radius * radius ? 0 : -1;
    const bq = 2 * _rel.dot(seg);
    const c = _rel.lengthSq() - radius * radius;
    if (c <= 0) return 0;
    const disc = bq * bq - 4 * a * c;
    if (disc < 0) return -1;
    const t = (-bq - Math.sqrt(disc)) / (2 * a);
    return t >= 0 && t <= 1 ? t : -1;
  }

  _killBolt(i) {
    this._b.active[i] = 0;
    this._b.owner[i] = null;
    this._boltCount--;
  }

  /** Hit sphere of the flown hull. Public catalogue data - see `_playerGun`. */
  _playerRadius() {
    return (SHIP_CLASSES[this.piloting?.shipId]?.length ?? 14) * 0.45;
  }

  /* ------------------------------------------------------------------ */
  /* Damage                                                              */
  /* ------------------------------------------------------------------ */

  _hostileHit(ship, damage, at) {
    if (!ship) return;
    this.stats.shotsHit++;
    const died = ship.damage(damage);
    this._burst(at, 12, 0.16, 3.0, 1.5, 0.5);
    this.bus?.emit?.('combat:hit', { position: at, target: ship.classId, damage, died });
    if (died) this._onKill(ship, at);
  }

  _onKill(ship, at) {
    this.stats.kills++;
    const bounty = ship.def.bounty;
    this.stats.bounty += bounty;
    this.economy?.add?.(bounty, 'bounty');
    this._explode(at, ship.def.radius);
    this._dropSalvage(ship);
    this.bus?.emit?.('combat:kill', {
      classId: ship.classId, name: ship.name, bounty, position: at,
    });
    this.bus?.emit?.('hud:notify', {
      text: `${ship.name} destroyed - ${bounty} CR bounty.`, tone: 'info',
    });
    /* Was that the last of them? Report the encounter and let the zone rearm. */
    if (!this.engaged) this._clearZone();
  }

  /**
   * A hit on the player.
   *
   * Shields first, then the hull, and "the hull" is the player's own health -
   * deliberately, rather than a second private pool. `Player.applyDamage`
   * already owns the damage event the HUD draws, the death that
   * `Piloting._onDied` catches to fly the wreck home, and the respawn. A
   * parallel hull bar would be a second health system that has to be kept in
   * step with the first, and the first is the one the rest of the game reads.
   */
  _playerHit(damage, at, owner) {
    this.stats.taken += damage;
    if (owner) owner.hits++;
    this._shieldIdle = 0;
    this._burst(at, 9, 0.14, 0.5, 2.0, 3.2);

    let through = damage;
    if (this.shield > 0) {
      const absorbed = Math.min(this.shield, damage);
      this.shield -= absorbed;
      through -= absorbed;
      this.hitFlash = 0.28;
      this.hitKind = this.shield <= 0 ? 'down' : 'shield';
    } else {
      this.hitFlash = 0.34;
      this.hitKind = 'hull';
    }

    if (through > 0) {
      /* The panel's published "10% less hull damage" per tier, applied
       * literally to what got through, with a floor so a maximum-shield Dray
       * (tier 6 -> 60%) is tough rather than immortal. */
      const tier = this.tiers().shield;
      const mul = Math.max(0.4, 1 - 0.10 * tier);
      this.player?.applyDamage?.(through * mul, at, 'laser');
    }

    this.bus?.emit?.('combat:playerHit', {
      damage, through, shield: this.shield, shieldMax: this.shieldMax,
      kind: this.hitKind, position: at,
    });
  }

  /**
   * Raise the hull banner while integrity is low, and drop it when it is not.
   *
   * Reads `Player.health` rather than a private pool, for the same reason
   * `_playerHit` deals damage into it: the hull IS the player's health here,
   * and a second number would be a second thing to keep in step.
   *
   * Allocates nothing - two floats and a string compare - and the string is
   * only rebuilt when the rung changes, because `_warnText` is written into
   * the DOM by `FlightHUD._drawFight` whenever `warn > 0`.
   */
  _hullAlarm(dt) {
    const hp = Number(this.player?.health);
    const max = Number(this.player?.maxHealth);
    if (!Number.isFinite(hp) || !Number.isFinite(max) || max <= 0) return;
    const frac = hp / max;

    const rung = frac <= HULL_CRIT_FRAC ? 'crit' : frac <= HULL_WARN_FRAC ? 'warn' : null;
    if (!rung) {
      /* Out of the woods. Clear only OUR banner - a zone-arrival or hold-full
       * warning set by something else is not ours to cancel, which is why the
       * owning rung is tracked rather than inferred from the text. */
      if (this._hullRung) { this._hullRung = null; if (this.warn > 0) this.warn = 0; }
      this._hullSince = 0;
      return;
    }

    this._hullSince = (this._hullSince ?? 0) - dt;
    if (rung !== this._hullRung || this._hullSince <= 0) {
      this._hullRung = rung;
      this._hullSince = WARN_REPEAT;
      this.warn = WARN_HOLD;
      this._warnText = rung === 'crit'
        ? `HULL CRITICAL - ${Math.round(frac * 100)}% - break off`
        : `Hull damaged - ${Math.round(frac * 100)}%`;
    }
  }

  /** Size the pool from the current hull's tier and fill it. */
  _chargeShield() {
    this.shieldMax = Math.max(SHIELD_FLOOR, SHIELD_PER_TIER * this.tiers().shield);
    this.shield = this.shieldMax;
    this._shieldIdle = SHIELD_DELAY;
  }

  _regen(dt) {
    /* The pool is re-derived every step rather than on board, because a player
     * can buy a shield tier at the yard, launch, and the panel would otherwise
     * be selling a number that only takes effect next session. */
    const want = Math.max(SHIELD_FLOOR, SHIELD_PER_TIER * this.tiers().shield);
    if (want !== this.shieldMax) {
      /* Keep the FRACTION when the ceiling moves, so an upgrade bought
       * mid-session neither refills a depleted shield nor leaves a full one
       * looking damaged. */
      const frac = this.shieldMax > 0 ? this.shield / this.shieldMax : 1;
      this.shieldMax = want;
      this.shield = want * frac;
    }
    this._shieldIdle += dt;
    if (this._shieldIdle > SHIELD_DELAY && this.shield < this.shieldMax) {
      this.shield = Math.min(this.shieldMax, this.shield + SHIELD_REGEN * dt);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Encounters                                                          */
  /* ------------------------------------------------------------------ */

  /** Take the zones the live world publishes. Replace, never merge. */
  _adopt() {
    const w = this.worldManager?.active ?? null;
    const zones = Array.isArray(w?.encounters) ? w.encounters : [];
    this._zones = zones;
    /* Every hostile belongs to the world it was launched in. A world change
     * that this system did not cause is a fight that is over. */
    this.standDown('world');
  }

  /** Send everyone home. */
  standDown(reason = 'manual') {
    let any = false;
    for (const h of this.hostiles) {
      if (h.alive || h.dying > 0) { h.retire(); any = true; }
    }
    if (this.zone && any && reason !== 'cleared') {
      /* Ran away, or docked, or descended. A shorter rearm than a clear,
       * because the fight is unfinished rather than won. */
      this._cool.set(this.zone.id, REARM_FLED);
    }
    this.zone = null;
    this.target = null;
    /* An armed-but-unlaunched zone is part of the fight and dies with it -
     * otherwise disembarking or changing world would leave an interdiction
     * standing over an empty patch of sky. */
    this._armed = null;
    this._lockT = 0;
    if (this.piloting) this.piloting.interdicted = false;
    if (any) this.bus?.emit?.('combat:standdown', { reason });
  }

  _clearZone() {
    const z = this.zone;
    if (!z) return;
    this._cool.set(z.id, z.rearm ?? REARM_CLEARED);
    this.zone = null;
    this.bus?.emit?.('combat:cleared', { zone: z.id, name: z.name, bounty: this.stats.bounty });
    this.bus?.emit?.('hud:notify', { text: `${z.name} clear.`, tone: 'info' });
  }

  /**
   * ARMING AND LAUNCHING ARE TWO DIFFERENT THINGS, and separating them is what
   * stops a wing being flown past at 5,000 m/s. See the header.
   *
   * Crossing a trigger sphere arms the zone; arming writes `interdicted`,
   * which drops the transit drive and cancels `Piloting`'s displacement
   * multiplier the same step; the wing launches on the first step after the
   * drive has finished spooling down. `Flight.transitState` is the whole test:
   * the multiplier is not damped and is already 1 by then (its
   * `_clearOfEverything` refuses while interdicted), so the drive is the only
   * thing left that can still be moving the ship faster than it looks.
   */
  _underway() {
    const s = this.piloting?.flight?.transitState;
    return !!s && s !== 'off';
  }

  _spawner(dt) {
    for (const [k, v] of this._cool) {
      const next = v - dt;
      if (next <= 0) this._cool.delete(k); else this._cool.set(k, next);
    }
    if (this.engaged) {
      /* Already fighting: the only question is whether the player has left.
       * Measured from the CENTROID of the living wing rather than from the
       * zone, because a running fight drifts kilometres from where it started
       * and a disengage test against a fixed point would either never fire or
       * fire while the shooting was still going on. */
      _v.set(0, 0, 0);
      let n = 0;
      for (const h of this.hostiles) if (h.alive) { _v.add(h.position); n++; }
      if (n > 0) {
        _v.divideScalar(n);
        if (_v.distanceTo(this.piloting.flight.position) > DISENGAGE) this.standDown('fled');
      }
      return;
    }
    /* Wrecks are still burning; do not start a second fight over the first. */
    for (const h of this.hostiles) if (h.dying > 0) { this._armed = null; return; }

    const p = this.piloting.flight.position;
    if (p.distanceTo(_mouth) < SAFE_RADIUS) { this._armed = null; return; }

    /* An already-armed zone stays armed on its LEASH rather than on its own
     * sphere: the drive it just cut covers about 3.1 km shedding 5,000 m/s,
     * and a zone that disarmed at the sphere edge would interdict the player
     * and then be coasted out of before it could launch anything. */
    if (this._armed) {
      if (this._cool.has(this._armed.id)) {
        this._armed = null;
      } else {
        _v.set(this._armed.position[0], this._armed.position[1], this._armed.position[2]);
        if (p.distanceTo(_v) > this._armed.radius + ARM_LEASH) this._armed = null;
      }
    }

    if (!this._armed) {
      for (const z of this._zones) {
        if (this._cool.has(z.id)) continue;
        _v.set(z.position[0], z.position[1], z.position[2]);
        if (p.distanceTo(_v) > z.radius) continue;
        this._armed = z;
        break;
      }
    }
    if (!this._armed) return;

    /* Held here, and only here, while the drive spools down. `interdicted` is
     * already true this step - it is written from `_armed` at the bottom of
     * `fixedUpdate` - so this is a wait of about `transitSpoolDown`, not an
     * open-ended one. */
    if (this._underway()) return;

    const z = this._armed;
    this._armed = null;
    this._launch(z);
  }

  /**
   * Put a wing in the sky ahead of the player.
   *
   * The cone is biased forward but not centred on the nose. `0.85` of the
   * forward vector plus a lateral of 0.28 to 0.80 puts a craft between 18 and
   * 43 degrees off it. Those two numbers are measured against the real frustum
   * rather than chosen: `CONFIG.render.fov` is 75 degrees vertical, which at
   * 16:9 is 106 horizontal, so the corner of the plate is 53 degrees off the
   * nose. A wing at 43 is inside it with room to spare - and one at the 64
   * degrees the first version produced was OFF SCREEN when it launched, which
   * turns "three sparks closing on you" into "you are suddenly being shot".
   *
   * Directly ahead would read as a spawn; directly behind would be an ambush
   * the player never saw coming, which the brief rules out in as many words.
   */
  _launch(zone) {
    const f = this.piloting.flight;
    f.forward(_fwd);
    f.right(_right);
    f.up(_up);

    let launched = 0;
    for (const entry of zone.wing) {
      const count = entry.count ?? 1;
      for (let i = 0; i < count; i++) {
        const ship = this._take(entry.class);
        if (!ship) continue;
        const a = (this.rnd() * 2 - 1) * Math.PI;
        const lat = 0.28 + this.rnd() * 0.52;
        _v.copy(_fwd).multiplyScalar(0.85)
          .addScaledVector(_right, Math.cos(a) * lat)
          .addScaledVector(_up, Math.sin(a) * lat * 0.6)
          .normalize();
        const d = SPAWN_MIN + this.rnd() * (SPAWN_MAX - SPAWN_MIN);
        _v2.copy(f.position).addScaledVector(_v, d);
        ship.spawn(_v2, f.position, { holdFire: HOLD_FIRE, zone });
        launched++;
      }
    }
    if (launched === 0) return;

    this.zone = zone;
    this.warn = 4.2;
    this._warnText = zone.warn ?? 'Unknown transponders - closing';
    this.bus?.emit?.('combat:contacts', { zone: zone.id, name: zone.name, count: launched });
    this.bus?.emit?.('hud:notify', {
      text: `${launched} hostile contact${launched > 1 ? 's' : ''} - ${zone.name}.`, tone: 'warn',
    });
  }

  /** A free craft of a class, building the shared model on first use. */
  _take(classId) {
    if (!ALIEN_CLASSES[classId]) {
      console.error(`[SpaceCombat] encounter names unknown class "${classId}"`);
      return null;
    }
    for (const h of this.hostiles) {
      if (h.classId === classId && !h.alive && h.dying <= 0) return h;
    }
    if (this.hostiles.length >= MAX_HOSTILES) return null;
    let model = this._models.get(classId);
    if (!model) {
      model = buildAlienModel(classId);
      this._models.set(classId, model);
    }
    /* One `Group` per craft over SHARED geometry and materials. Cloning the
     * group is what makes a second skiff free: four `Mesh` objects pointing at
     * buffers that already exist on the GPU. */
    const g = model.group.clone(true);
    g.visible = false;
    this.group.add(g);
    const ship = new AlienShip({
      classId,
      model: { group: g, def: model.def, muzzles: model.muzzles },
      rnd: this.rnd,
    });
    this.hostiles.push(ship);
    return ship;
  }

  /* ------------------------------------------------------------------ */
  /* Salvage                                                             */
  /* ------------------------------------------------------------------ */

  _buildSalvage() {
    const geo = new THREE.OctahedronGeometry(2.6, 0);
    const mat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.4, 1.55, 0.42), fog: false, toneMapped: false,
    });
    this._salvGeo = geo;
    this._salvMat = mat;
    this._salvMesh = new THREE.InstancedMesh(geo, mat, MAX_SALVAGE);
    this._salvMesh.name = 'combat:salvage';
    this._salvMesh.frustumCulled = false;
    this._salvMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.add(this._salvMesh);
    this._salv = [];
    for (let i = 0; i < MAX_SALVAGE; i++) {
      this._salv.push({
        active: false, t: 0,
        pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        credits: 0, bulk: 0, name: '',
      });
    }
  }

  _dropSalvage(ship) {
    const s = this._salv.find((x) => !x.active);
    if (!s) return;
    s.active = true;
    s.t = SALVAGE_LIFE;
    s.pos.copy(ship.position);
    /* It keeps the wreck's momentum, slowed. A canister that hangs motionless
     * where a craft doing 170 m/s exploded looks like a prop. */
    s.vel.copy(ship.velocity).multiplyScalar(0.25);
    s.credits = ship.def.salvage;
    s.bulk = ship.def.salvageBulk;
    s.name = `${ship.name} salvage`;
  }

  _stepSalvage(dt) {
    const p = this.piloting.flight.position;
    for (const s of this._salv) {
      if (!s.active) continue;
      s.t -= dt;
      s.pos.addScaledVector(s.vel, dt);
      if (s.t <= 0) { s.active = false; continue; }
      if (s.pos.distanceTo(p) > SCOOP_RANGE) continue;

      /* SALVAGE DOES NOT DISPLACE BETTER CARGO.
       *
       * -- THE DEFECT ------------------------------------------------------
       * The scoop is automatic and had no opinion about what it was scooping
       * into. Driven cold: one skiff kill loaded 4 m3 of salvage worth 40 CR
       * into a 10 m3 Kestrel hold - 40% of the hull's entire capacity at
       * 10 CR/m3 - against iridite's 310 CR for one cubic metre. The tester's
       * note: "I never chose to pick it up and was never told."
       *
       * That was already a bad trade. It is a worse one now that being shot
       * down empties the un-banked hold (`Piloting._onDied`), because the
       * player is carrying a real stake and the ship keeps deciding to swap
       * some of it for scrap.
       *
       * The rule is the one a pilot would apply: a canister worth LESS per
       * cubic metre than what is already aboard is left where it is. Both
       * numbers are ones the game already has - `cargoValue / cargoUnits` is
       * the hold's own rate - so nothing here is a new threshold to keep
       * honest. An empty hold takes anything, which keeps the scoop the
       * pleasant thing it is on a patrol you flew out empty for.
       *
       * The canister is not destroyed. It floats its full `SALVAGE_LIFE`, so a
       * pilot who sells and comes back can still have it, exactly as a mineral
       * seam is left in the ground. */
      const units = this.piloting.cargoUnits;
      if (units > 0 && s.bulk > 0) {
        const holdRate = this.piloting.cargoValue / units;
        const salvageRate = s.credits / s.bulk;
        if (salvageRate < holdRate) {
          if (this.warn <= 0) {
            this.warn = 2.4;
            this._warnText = `Salvage left - ${Math.round(salvageRate)} CR/m³ against ${Math.round(holdRate)} aboard`;
          }
          continue;
        }
      }

      /* `stow` sizes a load as `round(size * 1.6)` cubic metres, so the bulk a
       * class publishes is divided back out here. Going through `stow` rather
       * than writing the hold directly is the point: it refuses BEFORE it
       * consumes, so a full hold leaves the canister in space rather than
       * eating it, exactly as a mineral node is left in the ground. */
      const res = this.piloting.stow({
        type: 'salvage',
        name: s.name,
        credits: s.credits,
        size: s.bulk / 1.6,
      });
      if (!res?.ok) {
        if (res?.reason === 'hold-full' && this.warn <= 0) {
          this.warn = 2.4;
          this._warnText = 'Hold full - salvage adrift';
        }
        continue;
      }
      s.active = false;
      this.stats.salvaged += s.credits;
      this.bus?.emit?.('combat:salvage', { credits: s.credits, bulk: s.bulk, name: s.name });
      this.bus?.emit?.('hud:notify', { text: `${s.name} aboard - ${s.credits} CR.`, tone: 'info' });
    }
  }

  /* ------------------------------------------------------------------ */
  /* Flares: muzzle bloom, impact sparks, wrecks                          */
  /* ------------------------------------------------------------------ */

  _buildFlares() {
    /* An icosahedron and not a textured billboard. A quad would need a
     * radial-gradient canvas texture, and a canvas at construction time is a
     * dependency on a DOM this system does not otherwise have - which matters,
     * because the headless test rig builds this. Twenty triangles of additive
     * white through the space grade's bloom is a soft ball of light anyway;
     * the bloom is doing the work the texture would have done. */
    this._flareGeo = new THREE.IcosahedronGeometry(1, 0);
    this._flareMat = new THREE.MeshBasicMaterial({
      color: 0xffffff, fog: false, toneMapped: false,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._flareMesh = new THREE.InstancedMesh(this._flareGeo, this._flareMat, MAX_FLARES);
    this._flareMesh.name = 'combat:flares';
    this._flareMesh.frustumCulled = false;
    this._flareMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this._flareMesh.renderOrder = 6;
    for (let i = 0; i < MAX_FLARES; i++) this._flareMesh.setColorAt(i, _col.setRGB(0, 0, 0));
    this.group.add(this._flareMesh);

    const N = MAX_FLARES;
    this._f = {
      px: new Float32Array(N), py: new Float32Array(N), pz: new Float32Array(N),
      vx: new Float32Array(N), vy: new Float32Array(N), vz: new Float32Array(N),
      t: new Float32Array(N), dur: new Float32Array(N), size: new Float32Array(N),
      r: new Float32Array(N), g: new Float32Array(N), b: new Float32Array(N),
      active: new Uint8Array(N),
    };
    this._flareHead = 0;
  }

  /** One flare. Colours are pre-tone-mapping, so >1 is what blooms. */
  _flare(at, dir, size, dur, r, g, b, speed = 0) {
    const f = this._f;
    let slot = -1;
    for (let k = 0; k < MAX_FLARES; k++) {
      const i = (this._flareHead + k) % MAX_FLARES;
      if (f.active[i] === 0) { slot = i; break; }
    }
    /* Unlike a bolt, a saturated flare pool recycles: a spark that is not
     * drawn costs nothing but a slightly thinner explosion, and refusing would
     * mean the LAST kill in a busy frame is the one with no visual. */
    if (slot < 0) { slot = this._flareHead; }
    this._flareHead = (slot + 1) % MAX_FLARES;

    f.px[slot] = at.x; f.py[slot] = at.y; f.pz[slot] = at.z;
    if (dir && speed) {
      f.vx[slot] = dir.x * speed; f.vy[slot] = dir.y * speed; f.vz[slot] = dir.z * speed;
    } else {
      f.vx[slot] = 0; f.vy[slot] = 0; f.vz[slot] = 0;
    }
    f.t[slot] = dur; f.dur[slot] = dur; f.size[slot] = size;
    f.r[slot] = r; f.g[slot] = g; f.b[slot] = b;
    f.active[slot] = 1;
  }

  /** A spray of sparks in every direction. */
  _burst(at, n, dur, r, g, b) {
    for (let i = 0; i < n; i++) {
      _v.set(this.rnd() * 2 - 1, this.rnd() * 2 - 1, this.rnd() * 2 - 1);
      if (_v.lengthSq() < 1e-6) _v.set(1, 0, 0);
      _v.normalize();
      this._flare(at, _v, 0.5 + this.rnd() * 0.9, dur * (0.6 + this.rnd()), r, g, b,
        14 + this.rnd() * 46);
    }
  }

  /** A wreck. One big slow flash and a lot of fast debris. */
  _explode(at, radius) {
    this._flare(at, null, radius * 2.6, 0.5, 4.0, 1.5, 0.5, 0);
    this._flare(at, null, radius * 1.3, 0.9, 3.0, 0.7, 0.2, 0);
    this._burst(at, 34, 0.55, 3.4, 1.0, 0.3);
    this._burst(at, 14, 1.1, 1.2, 0.35, 0.12);
  }

  /* ================================================================== */
  /* Frame                                                               */
  /* ================================================================== */

  /**
   * Drawing, plus the one deadline this system owns.
   *
   * It runs even when the player is not flying so that a wreck finishes
   * burning after they walk away from the seat - and that is also why the
   * dispersal deadline is checked here rather than inside `fixedUpdate`'s
   * `_playable()` branch. A player who buys thirty seconds of fan, docks, and
   * walks off must have it expire on schedule; expiring it only while flying
   * would leave the effect banked and the HUD chip - which counts down on the
   * same `engine.simElapsed` seconds and does NOT wait for a seat - lying
   * about it. This is the same one-place-decides shape `Combat.update` uses
   * for the damage boost, on the same clock. `_playerGun` reads the field.
   *
   * Runs AFTER `piloting.update` in `main.js`, because the aim marks below are
   * projected through the camera that `Piloting._composeCamera` has just
   * placed. Projecting through last frame's camera puts the reticle a frame
   * behind the nose, which at 1.4 rad/s of roll is visibly detached.
   */
  update(dt) {
    if (this._spreadBolts > 0 && this._buffNow() >= this._spreadUntil) this._spreadBolts = 0;
    this._drawBolts();
    this._drawFlares(dt);
    this._drawSalvage(dt);
    this._drawAim();
  }

  _drawBolts() {
    const b = this._b;
    const mesh = this._boltMesh;
    for (let i = 0; i < MAX_BOLTS; i++) {
      if (b.active[i] === 0) {
        _mtx.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _mtx);
        continue;
      }
      _v.set(b.vx[i], b.vy[i], b.vz[i]);
      const sp = _v.length();
      _v.divideScalar(sp || 1);
      _quat.setFromUnitVectors(_FWD_Z, _v);
      /* Length is a fixed streak rather than a step of travel: a bolt drawn
       * `v*dt` long would be 26.7 m at 60 Hz and 13.3 m at 120 Hz, so the guns
       * would visibly change calibre with the frame rate. */
      const long = b.side[i] === 0 ? 15 : 12;
      _scale.set(0.34, 0.34, long);
      /* Drawn CENTRED on the leading point pulled back by half a streak, so
       * the bright tip is where the maths says the bolt is. */
      _v2.set(b.px[i], b.py[i], b.pz[i]).addScaledVector(_v, -long * 0.5);
      _mtx.compose(_v2, _quat, _scale);
      mesh.setMatrixAt(i, _mtx);
      if (b.side[i] === 0) _col.setRGB(0.55, 3.6, 4.2);
      else _col.setRGB(4.0, 0.55, 0.18);
      mesh.setColorAt(i, _col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  _drawFlares(dt) {
    const f = this._f;
    const mesh = this._flareMesh;
    for (let i = 0; i < MAX_FLARES; i++) {
      if (f.active[i] === 0) {
        _mtx.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _mtx);
        continue;
      }
      f.t[i] -= dt;
      if (f.t[i] <= 0) {
        f.active[i] = 0;
        _mtx.makeScale(0, 0, 0);
        mesh.setMatrixAt(i, _mtx);
        continue;
      }
      f.px[i] += f.vx[i] * dt; f.py[i] += f.vy[i] * dt; f.pz[i] += f.vz[i] * dt;
      const k = f.t[i] / f.dur[i];
      /* Shrinks and dims together. `compose` with a positive scale is exact -
       * nothing here is inverted, which is the rule this world learned when
       * four boxes with a zero tile put NaN through the bloom and blacked out
       * 921,600 pixels. */
      const s = f.size[i] * (0.35 + k * 0.85);
      _v.set(f.px[i], f.py[i], f.pz[i]);
      _quat.identity();
      _scale.set(s, s, s);
      _mtx.compose(_v, _quat, _scale);
      mesh.setMatrixAt(i, _mtx);
      _col.setRGB(f.r[i] * k, f.g[i] * k, f.b[i] * k);
      mesh.setColorAt(i, _col);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }

  _drawSalvage(dt) {
    const mesh = this._salvMesh;
    this._spin = (this._spin ?? 0) + dt * 1.1;
    for (let i = 0; i < MAX_SALVAGE; i++) {
      const s = this._salv[i];
      if (!s.active) { _mtx.makeScale(0, 0, 0); mesh.setMatrixAt(i, _mtx); continue; }
      _quat.setFromAxisAngle(_up.set(0.3, 0.9, 0.2).normalize(), this._spin + i);
      _scale.setScalar(1);
      _mtx.compose(s.pos, _quat, _scale);
      mesh.setMatrixAt(i, _mtx);
    }
    mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Where the gun is pointing, and where to point it.
   *
   * Both are published as normalised device coordinates because the HUD is a
   * DOM overlay with no camera and no business having one. The AIM mark is the
   * nose line at the gun's own range; the LEAD mark is the firing solution for
   * the current target - the same one-iteration intercept the hostiles use,
   * run in the player's favour, and it is the single most useful thing on the
   * screen in a fight.
   */
  _drawAim() {
    const cam = this.camera;
    const p = this.piloting;
    if (!cam || !p?.active) { this.aim.on = false; this.lead.on = false; return; }

    const f = p.flight;
    f.forward(_fwd);
    _v.copy(f.position).addScaledVector(_fwd, CONVERGE);
    this._project(_v, this.aim);

    const t = this.target;
    if (!t?.alive) { this.lead.on = false; return; }
    const d = t.position.distanceTo(f.position);
    const tof = d / GUN.speed;
    /* The target's velocity relative to OURS: a bolt inherits nothing, but the
     * shooter is moving, so the lead that matters is the closure. */
    _v2.copy(t.velocity).sub(f.velocity).multiplyScalar(tof).add(t.position);
    this._project(_v2, this.lead);
    this.lead.range = d;
  }

  _project(worldPoint, out) {
    if (!this.camera) { out.on = false; out.x = 0; out.y = 0; return; }
    _v3.copy(worldPoint).project(this.camera);
    /* `project` divides by w, and w is negative behind the camera - which
     * flips both axes and puts a marker for something astern in the opposite
     * corner of the screen, confidently. The z test is the only honest way to
     * ask "is this in front of me".
     *
     * AND IT CAN DIVIDE BY ZERO. A point exactly on the camera plane has
     * `w === 0` and `project` hands back three infinities or three NaNs; a
     * point at the origin of a camera whose matrix has not been composed yet
     * does the same. Either one goes straight into a CSS `left:` as
     * "NaN%" - which the browser drops, silently pinning the marker to the
     * top-left corner - and, worse, is the exact class of value that put 19
     * NaN pixels through `UnrealBloomPass` and blacked out a frame. So the
     * finite test comes FIRST and a non-finite projection is simply not a
     * projection: `on` is false and the caller falls back to the bearing,
     * which is a normalised dot product and cannot be either. */
    if (!Number.isFinite(_v3.x) || !Number.isFinite(_v3.y) || !Number.isFinite(_v3.z)) {
      out.on = false;
      out.x = 0;
      out.y = 0;
      return;
    }
    out.on = _v3.z < 1 && Math.abs(_v3.x) <= 1.2 && Math.abs(_v3.y) <= 1.2;
    out.x = _v3.x;
    out.y = _v3.y;
  }

  /* ================================================================== */

  dispose() {
    this._offBoard?.();
    this._offWorld?.();
    this._offLeft?.();
    this._offTravel?.();
    for (const h of this.hostiles) h.model.group.parent?.remove(h.model.group);
    this.hostiles.length = 0;
    for (const m of this._models.values()) m.dispose?.();
    this._models.clear();
    this._boltGeo.dispose();
    this._boltMat.dispose();
    this._flareGeo.dispose();
    this._flareMat.dispose();
    this._salvGeo.dispose();
    this._salvMat.dispose();
    this.group.parent?.remove(this.group);
    this.group.clear();
  }
}
