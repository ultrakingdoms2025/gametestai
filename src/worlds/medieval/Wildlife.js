/**
 * Where the predators live, and - more importantly - where they do not.
 *
 * ---------------------------------------------------------------------------
 * THE DESIGN CLAIM THIS FILE HAS TO MAKE TRUE
 *
 * The deep forest should be genuinely dangerous, the HIGHWAY between towns
 * should be safe, and a FOREST TRACK should be neither. That is a claim about
 * DISTANCE, not about atmosphere, and it can only be true if the arithmetic
 * below is right, because a wolf does not respect a mood - it respects
 * `def.territory` and `def.sight`.
 *
 * The middle clause is new, and it is the whole of this revision. What shipped
 * before held every pack `reach * ROAD_SHARE + MARGIN` from EVERY road, which
 * is 59.4 m for a wolf against a 68 m reach - so a player who walked all 1,298
 * road samples of the network passed inside a pack's acquisition envelope on 30
 * of them, 2.3%, and the CEILING on that number with every legal cell of a 3 m
 * lattice occupied at once was 3.4%. The rule was not badly tuned; it was doing
 * exactly what it said, which was keeping predators away from travellers, on a
 * network that includes the tracks through the woods. Splitting the network in
 * two takes the ceiling to 9.4% and what is achieved to 7.1% (92 samples), of
 * which 91 are on forest track and one is on open highway.
 *
 * A pack is placed at a HOME, roams `territory` metres from it (`BeastNPC`
 * `_wanderNear`, and `strayed` pulls it back), and acquires anything it can see
 * within `sight`. So the furthest a pack can ACQUIRE a target from its home is
 *
 *     reach = territory + sight
 *
 * which is 68 m for a wolf (34 + 34) and 52 m for a bear (26 + 26). Every
 * clearance in this file is expressed against `reach` plus a margin rather than
 * against a number somebody liked the look of, so retuning a species' territory
 * moves the packs rather than silently putting one within scenting distance of
 * a market square.
 *
 * `reach` bounds ACQUISITION, not pursuit. `BeastNPC._roam` applies the
 * home pull-back, but `_stalk` drops a target only on `dist > loseInterest` -
 * so a beast that has already seen you has no home leash. That matters more now
 * than it did, because the whole point of this revision is that packs CAN see
 * the path: a wolf that acquires a walker on a forest track will follow them
 * off the map's whole width if they keep moving and stay inside 46 m. Nothing
 * in this file can fix that and nothing in this file should be read as if it
 * had; see the note in `medieval-wildlife.test.mjs` under THE HUNTED PATH,
 * which measures the exposure it leaves.
 *
 * The clearances, in the order they reject:
 *
 *   built        `reach + MARGIN` from the BUILT EXTENT of the world, as a
 *                union of discs and axis-aligned rectangles. Two sources: the
 *                tables every builder reads (`allBuildings`, `PLOTS`,
 *                `EXTRA_YARDS`, `CAMPS`, `CASTLE`, `MARKET`, the precinct, the
 *                palisade, the Reedwater jetties), and `world._footprints` -
 *                what the builders actually registered, which is the only
 *                description there is of the Greyoak stage, the three bridges
 *                and their crossing ramps, Fenwick's market furniture, the
 *                castle's 18 m approach apron, the mills, the watchtower and
 *                the two parish churches. Grimscar's workings are the other way
 *                round - a table, and no footprint at all. 139 of the
 *                234 registered footprints have a corner outside the union the
 *                tables alone describe, by up to 90.7 m - the crossing ramp at
 *                the south abutment of the Ashlea plank bridge, which stands in
 *                open country a hundred metres from anything a table names.
 *                See "THE CORDON IS A THEOREM" below.
 *   people       `reach + MARGIN` from every civilian the world will spawn or
 *                stream, AND from every waypoint of a hand-written patrol. This
 *                is the one that keeps a pack away from a lone questmaster,
 *                lorekeeper or roadside traveller who is nowhere near a
 *                settlement and would otherwise be eaten on sight. It is also
 *                the rule that survives this revision unchanged, and the reason
 *                letting predators watch the paths costs no civilian anything -
 *                see "WHO ELSE WALKS THE PATHS" below.
 *   road         `reach * ROAD_SHARE + MARGIN` from any OPEN-COUNTRY road:
 *                59.4 m for a wolf and 50.6 m for a bear. Deliberately less
 *                than the full reach - a road that no animal can ever be seen
 *                from is not a safe road, it is a road in a different world -
 *                but not by much: a wolf sees the last 8.6 m of a highway and a
 *                bear the last 1.4 m.
 *   track        `reach * TRACK_SHARE + TRACK_MARGIN` from any road at all,
 *                which is 41.4 m for a wolf and 32.6 m for a bear. This is the
 *                relaxed rule and it is what makes a forest track dangerous:
 *                41.4 m is inside a wolf's 68 m envelope, so a pack ACQUIRES a
 *                walker and charges, and it is outside a wolf's 34 m territory,
 *                so the pack cannot be standing on the surface when they get
 *                there. Applying it to EVERY road rather than only to tracks is
 *                deliberate: the highway rule above is what protects the
 *                highway, and this one only has to stop a pack roaming onto
 *                tarmac anywhere. See `TRACK_CANOPY` for which roads are which.
 *   water        clear of the channel and above the flood line, because a wolf
 *                cannot swim and `_auditWater` would spend its life dragging
 *                one out of the river.
 *   ground       inside the playfield, on woodland, on a walkable slope.
 *
 * ---------------------------------------------------------------------------
 * THE CORDON IS A THEOREM, NOT A TABLE READING
 *
 * This file used to reject a home within `s.radius + reach + MARGIN` of a
 * settlement's CENTRE, and that shipped a vale with no reachable wildlife in
 * it. `s.radius` is a SPACING radius - the distance a later phase uses to
 * refuse to drop a second settlement on top of this one - and it is set by the
 * single furthest thing a place owns. Aldermoor's 108 is set by one outlier
 * cottage at (-47, 12); the Keep Approach's 110 by the two ends of an ARC of
 * ten houses whose middle is empty ground. Stacking a wolf's 68 m reach and a
 * 22 m margin on top of that turned a 108 m village into a 198 m disc, and the
 * seventeen discs together left only 13.8% of the map's closed canopy legal for
 * a wolf - all of it on the outer rim.
 *
 * The obvious repair - measure the cordon from `SETTLEMENTS[].ground` instead -
 * is WRONG, and it is worth recording why, because it looks right. `ground` is
 * a DECORATION table: it is the beaten earth `settledAt` paints, and it is
 * under no obligation to cover a building. Thirty-three of the eighty-one town
 * buildings have footprint outside every ground feature of the town that owns
 * them, and four by more than MARGIN - rw-s4 by 26.1 m, rw-s3 and rw-s6 by
 * 24.9 m, rw-s2 by 24.2 m. All four are Reedwater's stilt row, which is left
 * out of the ground table on purpose, because painting mud on a jetty would be
 * worse than painting none. A cordon drawn on `ground` therefore admits a legal
 * wolf home at (-332, 12) whose threat envelope reaches 4.07 m INSIDE rw-s4's
 * wall. Measured, on a 0.5 m scan of the whole cordon-legal region.
 *
 * So the cordon is drawn round a BUILT-EXTENT UNION instead, and the point of
 * it is that it is provable rather than authored:
 *
 *   every shape in `builtShapes()` CONTAINS the real geometry it stands for,
 *   inflated by `WALL_PAD`; a legal home q clears every shape by `reach +
 *   MARGIN`; so every point within `reach` of q is at least `MARGIN + WALL_PAD`
 *   = 23.5 m from any wall in the world.
 *
 * That holds for every building in the world, not for the ones a decoration
 * table happens to mention. 23.5 m is a FLOOR, and the measured minimum sits
 * above it: a 0.5 m scan of the whole playfield against all 118 authored walls,
 * taking every point that clears the SHIPPED union (tables plus the world's 234
 * registered footprints) by `reach + MARGIN`, measures 25.00 m for a wolf and
 * 25.00 m for a bear, both at gs-alehouse. Against the TABLE-ONLY union - what a
 * caller with no world gets, and what the pure half of the gate proves over -
 * the same scan measures the bound being met exactly: 23.50 m for a wolf, at
 * gs-chapel, and 23.50 m for a bear, at rw-s6. Adding shapes can only push a
 * legal home further from a wall, so the theorem proved over the smaller union
 * holds over the shipped one.
 *
 * It is not paid for in canopy. Legal closed canopy under all seven rules, as a
 * fraction of the 7,772 closed-canopy cells of a 4 m lattice over the legal
 * playfield (|x|, |z| <= HALF - 30, which is the `inset` the production callers
 * pass), with production inputs:
 *
 *     OLD centre + radius     wolf 13.9%   bear 17.2%   worst wall +31.84 m
 *     REJECTED ground table   wolf 21.0%   bear 27.1%   worst wall  -4.07 m
 *     THIS built union        wolf 20.9%   bear 26.7%   worst wall +25.00 m
 *
 * i.e. the union buys back the entire guarantee for 0.4 points of bear canopy
 * and 0.2 of the wolf's, and frees half again as much canopy as the rule it
 * replaces - 7.0 points for a wolf and 9.5 for a bear.
 *
 * The whole table moved by about a tenth of a point when the road rule was
 * split in two, because "legal" now means eight rules rather than seven. The
 * worst-wall column did NOT move and cannot: that scan is over every point
 * clearing the CORDON and never asks about a road.
 *
 * The cell count and the percentages both moved when `Woodland.AUTHORED_WOODS`
 * put Hazelbrake in the starting valley - 7,439 cells became 7,772, and the
 * shipped row moved from 21.2/25.3 - because the denominator is the mask and the
 * mask now has a wood in it that it did not have. The worst-wall column did NOT
 * move, and cannot: that scan is over every point clearing the CORDON and never
 * asks about woodland at all. It was re-run at 0.5 m after the wood went in and
 * measures 25.00 m for both species, at gs-alehouse, exactly as before.
 *
 * The "worst wall" column is the same 0.5 m scan run for BOTH species and
 * minimised over the two, which for the old rule is the bear's number: a bear
 * clears by `52 + MARGIN` where a wolf clears by `68 + MARGIN`, so it is legal
 * 16 m closer to a settlement centre and it is the bear that gets nearest a
 * wall. Quoting a wolf-only figure under a column headed "worst wall" is how
 * the old row came to claim 33.56 m of slack it did not have.
 *
 * Every shape is a disc or an AXIS-ALIGNED rect, never a rotated one. That is
 * deliberate: `Towns.footprintDistance` and `MedievalWorld._inFootprint` both
 * evaluate a rotated rect with cos(-r)/sin(-r), which is the forward map rather
 * than its inverse. Measured against `Towns.footprintCorners`, which is exact,
 * that convention misplaces a wall by up to 2.66 m (fx-bell). A circumscribed
 * disc is rotation-invariant and cannot inherit it - and `hypot(w/2, d/2)` is
 * the circumradius exactly, so the containment costs nothing but the corners.
 *
 * The defect is ROUTED AROUND rather than fixed, and the reason is measured
 * rather than asserted. 122 of the world's 234 registered footprints stand at
 * an angle that is not a quarter turn; correcting the sign moves 2,276 square
 * metres of the vale across the "is this inside a building" line, and two of
 * the 108 planned civilians change from standing on open ground to standing in
 * a wall - which moves the roster, which moves the packs, which invalidates
 * every number in this file. `medieval-spatial-index.test.mjs` also pins
 * `_inFootprint` to a linear reference that reproduces the same sign, and the
 * world compensates for it in places (`_jetty` registers `r: -yaw` for a plank
 * it drew at `+yaw`). Fixing it is a separate change with its own gate, and
 * the test above is written so that it fails the day somebody makes it.
 *
 * ---------------------------------------------------------------------------
 * SITES ARE CHOSEN NEAREST-THE-ROAD-FIRST, WITH A QUOTA ON TOP
 *
 * Freeing the canopy is necessary and not sufficient. A uniform dart that
 * accepts the first legal spot it hits lands in proportion to AREA, and the
 * legal area is overwhelmingly the empty outer rim. `planBeasts` therefore
 * darts a POOL of legal homes and takes them nearest-a-road-first, which is the
 * property `ROAD_SHARE` was written to express and never delivered.
 *
 * A global sort is still not enough, and this is the part the player reported.
 * The ring roads outvote the vale roughly four nodes to one, so a sort that is
 * only trying to be near SOME road puts every pack on the ring and none within
 * streaming range of the valley the player spawns in. `REGIONS` fixes that with
 * a minimum per region, filled from that region's own legal pool before the
 * global deal runs.
 *
 * WHAT THE QUOTA CAN BUY, measured on a 4 m lattice over the original 400 m
 * vale (|x|, |z| <= 200) with production inputs:
 *
 *     legal WOLF homes in the core vale         39 - all in one cluster at
 *                                               (-136..-112, 116..148)
 *     legal BEAR homes in the core vale        142 - 128 of them in the same
 *                                               place, (-136..-88, 104..160),
 *                                               eleven at (188..200,
 *                                               -120..-104), two on the
 *                                               northern rim at z 200 and one
 *                                               at (-188, 184)
 *
 * BOTH OF THOSE NUMBERS USED TO BE SMALLER, AND THE WOLF'S USED TO BE ZERO.
 * That zero was not a tuning failure and the quota could not argue with it: of
 * the 10,201 lattice cells a wolf loses 7,825 to the built cordon, 801 to the
 * flood line, 539 to the people cordon and 388 to the channel (`rejectHome`
 * returns the FIRST rule that fires, so a wider cordon takes cells the later
 * rules would otherwise have counted), and what was left over lost all of
 * itself to the woodland mask, because the noise had put no closed canopy in
 * the starting valley at all. Deleting the built cordon outright buys a wolf
 * 110 cells and deleting the people cordon buys 43, and both of those are the
 * safety guarantees this file exists to keep, so neither was ever on the table.
 *
 * What fixed it was neither: `Woodland.AUTHORED_WOODS` now puts a wood -
 * Hazelbrake, centred (-110, 125) - inside the valley, and the 39 wolf cells
 * and 128 of the bear cells above ARE that wood. The woodland rejection count
 * fell from 648 to 609 in the process, which is the whole of the change as this
 * file sees it: the mask is an input here, and the fix was made where the mask
 * is authored.
 *
 * WHAT THE PLAYER ACTUALLY GETS. The quota is ONE and a WOLF fills it, at
 * (-131.4, 115.7), 195.5 m from the spawn point. Its nearest core-vale road
 * node is 96.8 m away - on `vale` itself, at (-45, 72) - which is inside both
 * `MedievalResidency.spawnRadius` (175 m) and the distance at which a hidden
 * character is allowed to APPEAR, so it streams AND it is drawn for a player
 * who never leaves the valley's own roads. That is the whole report, answered.
 *
 * THE DRAW RADIUS IS 125, NOT 135, and every margin here is quoted against the
 * smaller number. `NPCManager`'s render gate is HYSTERETIC -
 * `npc.root.visible ? d < RENDER_OUT : d < RENDER_IN` - and a streamed pack
 * arrives invisible, so RENDER_OUT (135) is only the distance at which one that
 * is ALREADY drawn stops being drawn. A pack that streams in at 135-175 m is
 * hidden on its first LOD tick and cannot appear until 125. Nine of the twelve
 * packs come within 125 m of some road; eleven come within 135, which is the
 * number this file used to quote and which describes nothing a player sees.
 *
 * Measured over the 269 samples of the core vale's own roads: 120 of them
 * (44.6%) have a pack inside the 175 m streaming radius and 25 (9.3%) have one
 * inside the 125 m appearance radius, against measured ceilings of 69.5% and
 * 24.5%.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE WHOLE CHANGE MEASURES
 *
 * Every figure below is on the SHIPPED configuration - `world._slope`, the
 * production civilian roster of 108 plus the 41 authored patrol waypoints,
 * `world._roadSegs` including the seventeen village lanes, and the shipped
 * woodland mask WITH Hazelbrake in it - and is reproduced by
 * `medieval-wildlife.test.mjs`, which builds the real world rather than a
 * stand-in for it.
 *
 * "before" is this same world with `openRoadDist` omitted, i.e. every road a
 * highway, which is the rule this file shipped with. It is the ablation the
 * gate replays, and it is one line: leave the argument out.
 *
 *                                        before    after  ceiling
 *   ENCOUNTER - road samples in reach      2.3%     7.1%     9.4%
 *      (as counts of 1,298 samples)          30       92      122
 *      of which on a forest track            26       91        -
 *      of which on open highway               4        1        -
 *   roadside canopy in a pack's reach     13.7%    22.8%    26.3%
 *      (as counts of 1,477 cells)           202      337      389
 *   road nodes within 175 m of a pack     74.1%    77.0%    90.8%
 *   the SAME on the core vale's roads     44.6%    44.6%    69.5%
 *   core-vale roads within 125 m: DRAWN    8.6%     9.3%    24.5%
 *   packs a road walker can ever SEE       9/12     9/12       -
 *   nearest pack to the player spawn      196 m    196 m    175 m
 *
 * The ceiling is unlimited packs on every legal cell of a 3 m lattice - 6,626
 * of them under the shipped rules: it is what the clearances themselves permit,
 * and no selection rule can beat it. The SEE row has no ceiling entry because
 * none was computed - "the largest set of legal homes that are 90 m apart and
 * each within 125 m of a road node" is a packing problem nobody has solved
 * here.
 *
 * WHAT THE ENCOUNTER ROW COST, and it is worth being plain about it: nothing
 * that this file promises. The worst wall clearance over the shipped placement
 * is 35.06 m against a 23.5 m floor, the worst clearance to a civilian is
 * 22.22 m against a 22 m floor, no envelope touches trodden ground, and the
 * closest a pack's territory comes to the metalled surface is 7.95 m. The
 * highway rule is untouched, and the ONE highway sample now inside an envelope
 * is inside it by the same arithmetic that put four there before: `ROAD_SHARE`
 * is 0.55 and not 1.0, on purpose.
 *
 * WHAT IT DID NOT BUY. The core vale's own roads gain almost nothing - 8.6% to
 * 9.3% - and the ENCOUNTER row there is 0.0% before and after. That is measured
 * rather than shrugged at: of the 2,615 cells of Hazelbrake's disc that lie
 * nearer a road than the best legal one, 920 are refused by the Aldern mill's
 * cordon, 790 by the flood line, 535 by the people cordon and 260 by the
 * channel. NOT ONE of them is refused by a road rule. The starting valley's
 * wood is hemmed in by the mill and the river, and no clearance this file is
 * allowed to touch can free it; the lever that would is another entry in
 * `Woodland.AUTHORED_WOODS`, which is where the last one went.
 *
 * A SECOND THING IT DID NOT BUY, stated because somebody will otherwise assume
 * it did. 7.1% is 77% of what twelve packs could reach if they were placed to
 * maximise coverage rather than nearest-a-road-first: a greedy set-cover over
 * the same legal cells, same `minApart`, reaches 120 samples (9.2%) and then
 * runs out of clusters at the fifth pack. The gap is the selection rule, not
 * the clearances. Closing it is a change to `planBeasts`'s sort and it is not
 * made here.
 *
 * ---------------------------------------------------------------------------
 * WHO ELSE WALKS THE PATHS
 *
 * `BeastNPC._candidates` is the player AND every live friendly, so a rule that
 * lets a pack watch a track lets it watch whoever else is on that track. The
 * vale has 108 civilians and 96 of them stream; eight are travellers who are
 * placed ON the verge by definition. So the question is not rhetorical: does
 * this revision feed the postman to the wolves?
 *
 * Measured, over every point a civilian can occupy - the spawn pin, the whole
 * `homeRadius` free-roam disc, every patrol waypoint and every metre of the
 * straight legs between them - against every pack's acquisition envelope:
 *
 *     acquirable anywhere on their route, before   0 of 108
 *     acquirable anywhere on their route, after    0 of 108
 *     worst clearance, over all of that ground     22.22 m (was 22.28 m)
 *
 * ZERO, and it is a property rather than luck. MARGIN is 22 because
 * `FriendlyNPC.homeRadius` is `12 + rnd() * 10`, so the people cordon covers a
 * civilian's whole free-roam disc - and every patrol the PLANNER writes is
 * shorter than that disc: a resident's reaches 21.88 m from its spawn and a
 * traveller's 20.06 m, because `planTravellers` crops the road polyline to six
 * indices either side of the pin and the polyline is sampled at 2.5 m.
 *
 * That argument did NOT cover the hand-written ones, and that is the one real
 * hole this work found: Sister Meriet's authored patrol takes her 45.19 m from
 * her spawn, twice MARGIN, and nothing was stopping a pack from sitting on the
 * far end of it. `Inhabitants.js` now feeds every authored patrol waypoint to
 * the cordon as if it were a person - 41 extra points, no measurable cost - so
 * the guarantee is about the ROUTE and not about the pin. This is option (c) of
 * the three that were on the table: keep the full people cordon, and make it
 * mean what it says. (a) accepting attrition was never necessary, because the
 * measurement says there is none to accept; (b) teaching beasts to deprioritise
 * friendlies would have been a behaviour change bought to solve a problem that
 * does not exist.
 *
 * WHAT IS STILL NOT COVERED, and it is the pursuit leash. All of the above
 * bounds ACQUISITION from a pack's home. Once a beast has a target it will
 * follow it anywhere - `_stalk` drops it only past `loseInterest` - so a wolf
 * that takes the player on a forest track and is led toward a village arrives
 * there with the village's civilians inside its own `sight`. Measured in a live
 * session before this change: two of five wolves from one pack were 102.6 m and
 * 124.4 m from a home with a 34 m territory inside two minutes. Nothing here
 * bounds that and nothing here pretends to.
 *
 * ---------------------------------------------------------------------------
 * WOODLAND IS THE SAME MASK THE TREES USE - LITERALLY THE SAME FUNCTION
 *
 * `woodlandAt` IS `Woodland.woodMask`, bound by identity rather than copied,
 * with `DEEP_WOOD` as the line between "trees in a field" and "forest". It used
 * to be the noise term written out a second time, which agreed for exactly as
 * long as the mask was nothing but noise; `Woodland.AUTHORED_WOODS` ended that,
 * and a copy would have gone on returning the old answer in silence. See the
 * note on the export itself.
 *
 * The mask is NOT the density the scatter plants at: `Woodland.standAt` ramps
 * the same mask over EDGE_LO 0.07 / EDGE_HI 0.22 and then removes up to 90% of
 * it in a glade. So a home at exactly `DEEP_WOOD` is inside authored closed
 * canopy and may still be standing in a clearing. The mask is the legality
 * test; the stand is what you see.
 *
 * The mask is an INPUT here. Where a wood is, is `Woodland`'s decision, and the
 * one time this file needed a wood that did not exist - the starting valley -
 * the fix was made there rather than by loosening a clearance here.
 *
 * Nothing in this file may import `three`.
 */

import {
  riverZ, riverHalfWidth, medievalHeight, HALF, WATER_Y, rectDist,
  CASTLE, MARKET,
} from '../terrain/MedievalHeight.js';
import { SETTLEMENTS, PLOTS, EXTRA_YARDS } from './Settlements.js';
import {
  TOWNS, allBuildings, CEOLWINE_PRECINCT, BLACKMARCH_PALISADE, REEDWATER_JETTIES,
  GRIMSCAR_WORKINGS,
} from './Towns.js';
import { CAMPS } from './Camps.js';
import { woodMask } from './Woodland.js';
/* The ANIMAL's own number, imported rather than restated - see `reachFor`.
 * `BeastSpecies` is a table with no three.js and no DOM in it, which is the
 * only reason this file is allowed to reach for it: what a wolf IS belongs
 * there, and how many of them the vale holds belongs here. */
import { threatRadius } from '../../npc/BeastSpecies.js';
import { GridIndex } from './GridIndex.js';
import { streamFor } from './Population.js';

/**
 * The woodland mask. THE SAME FUNCTION the trees are planted from, by identity.
 *
 * This used to read `fbm2(x * 0.0062, z * 0.0062, 3)` - `Woodland.woodMask`'s
 * body, copied. It agreed for as long as the mask was pure noise, and the day
 * `Woodland` gained an authored term it would have stopped agreeing silently,
 * in the worst of the two possible directions: trees with no legal beast under
 * them, or a legal beast standing in a field. Nothing would have failed. The
 * gate that looked like it covered this - "every pack lives in closed canopy" -
 * checks the PLAN against `woodlandAt`, so it agrees with itself either way.
 *
 * It is an alias rather than a wrapper so that `woodlandAt === woodMask` is
 * literally true and can be asserted as such;
 * `medieval-wildlife.test.mjs` does assert it, which is the only form of this
 * check that cannot rot.
 *
 * `Woodland.js` imports neither `three` nor the DOM and does not import this
 * file, so there is no cycle and no rule broken. What it does do is integrate
 * `STAND_AREA` at load, ~12 ms, which every consumer of this module now pays.
 */
export const woodlandAt = woodMask;

/**
 * Closed canopy. `Woodland` uses this same number to switch from scattered
 * broadleaf to pine and birch, i.e. it is the line between "trees in a field"
 * and "forest".
 */
export const DEEP_WOOD = 0.16;

/**
 * Clearance margin on top of a species' own reach, metres.
 *
 * Against BUILDINGS it is genuine slack, and `WALL_PAD` adds 1.5 m to it.
 *
 * Against PEOPLE it is not slack at all, and that is worth knowing before
 * anybody trims it: `FriendlyNPC` sets `homeRadius = 12 + rnd() * 10`, so a
 * civilian free-roams up to 22 m from the position planned for it. MARGIN is
 * exactly that number, so `reach + MARGIN` is precisely "a pack cannot acquire
 * a civilian even at the far edge of that civilian's wander", with nothing to
 * spare. The old placement left 56.2 m of accidental slack on top; pulling the
 * packs toward the roads spends it, and the shipped placement measures 22.22 m
 * - the guarantee, and 0.22 m more. That is the tightest this rule has ever
 * been held and it is held BY the rule rather than by luck, which is the point;
 * `medieval-wildlife.test.mjs` asserts it.
 *
 * The argument covers a PLANNED civilian's wander and says nothing about a
 * hand-written patrol, which can be any length at all; `Inhabitants.js` closes
 * that by passing the waypoints in as people. See "WHO ELSE WALKS THE PATHS".
 *
 * Buying real slack means raising MARGIN, and the measured price of +22 m on
 * the people rule alone is 5.3 points of legal wolf canopy (20.9% -> 15.6%),
 * 7.0 of bear (26.7% -> 19.7%), and every one of the 39 legal wolf homes in the
 * core vale - it takes that count to zero, i.e. it undoes Hazelbrake and empties
 * the starting valley of wolves again, leaving 26 bear homes where there are
 * now 142.
 */
export const MARGIN = 22;

/**
 * How much of a predator's reach has to fit between it and the nearest HIGHWAY.
 *
 * Less than 1 on purpose - see the header. At 0.55 a wolf may be 59.4 m from an
 * open-country road and a bear 50.6 m, against reaches of 68 and 52: so a pack
 * can see the last 8.6 m (wolf) or 1.4 m (bear) of open road at the far edge of
 * its acquisition envelope, and no more. That is the difference between a road
 * that is watched and a road that is safe, and it is deliberately not zero.
 *
 * What this no longer governs is the whole network. See `TRACK_MARGIN`.
 */
export const ROAD_SHARE = 0.55;

/**
 * The same share, applied to a FOREST TRACK instead of a highway.
 *
 * Identical to `ROAD_SHARE` on purpose: what distinguishes a track from a
 * highway here is not how much of the animal's reach has to fit beside it, it
 * is the MARGIN on top - see `TRACK_MARGIN`. Writing it as its own constant is
 * what lets the two be retuned apart if they ever should be, and what lets the
 * gate quote them separately.
 */
export const TRACK_SHARE = ROAD_SHARE;

/**
 * The margin a pack keeps off a forest track, metres. Four, against 22.
 *
 * MARGIN's job on a highway is that a pack cannot ACQUIRE a traveller on it.
 * On a track that is exactly what it is supposed to be able to do, so the only
 * job left is that a pack cannot STAND on the metalled surface - and that is a
 * statement about `territory`, not about `reach`.
 *
 * Worked through for the shipped species: a wolf clears a track by
 * `68 * 0.55 + 4` = 41.4 m and roams 34, so it stops 7.4 m short of the cobble
 * edge; a bear clears by `52 * 0.55 + 4` = 32.6 m and roams 26, stopping 6.6 m
 * short. `medieval-wildlife.test.mjs` asserts that property for every species
 * in `BeastSpecies` rather than for these two, because the arithmetic that
 * makes it true - `reach * TRACK_SHARE + TRACK_MARGIN > territory` - is not
 * guaranteed by anything except the current numbers.
 *
 * Four rather than more, measured. Encounter rate against the value of this
 * constant, on the shipped world, everything else held: 0 m -> 7.4%,
 * 2 m -> 7.2%, 4 m -> 7.1%, 6 m -> 4.8%, 8 m -> 4.7%. There is a cliff between
 * 5 and 6 because one cluster of legal ground sits 36 m off `grimscarway`, and
 * 4 buys the standing room without going over it.
 */
export const TRACK_MARGIN = 4;

/**
 * How near closed canopy has to come to a stretch of road for it to be a TRACK.
 *
 * Not a new number: it is the radius `medieval-wildlife.test.mjs` already uses
 * to define THE DANGEROUS WOOD - "closed canopy within 40 m of a road", the
 * forest a player actually walks into. A road is a forest track exactly where
 * it runs through the band the gate already calls the forest. Reusing it means
 * the ground the packs are allowed near and the ground the reachability floor
 * is measured over are the same ground, by construction.
 *
 * Measured on the shipped network: 810 of the 1,259 road segments are tracks
 * at 40 m and 449 are open highway. The classification is not very sensitive -
 * 551 at 25 m, 985 at 55 m - and the encounter rate moves by less than a point
 * across that whole range, because what actually binds is where the legal
 * ground is, not where the classification line falls.
 */
export const TRACK_CANOPY = 40;

/**
 * True when closed canopy comes within `radius` of (x, z).
 *
 * A ring scan rather than a mask threshold, and that is not fussiness: the mask
 * is steep near a wood's edge. Measured at the cluster of legal ground beside
 * `blackmarchway` that this rule exists to free, the mask reads -0.051 ON the
 * road and 0.161 thirty-six metres away, so no threshold evaluated at the road
 * point could tell that stretch from open moor.
 */
export function nearCanopy(x, z, radius = TRACK_CANOPY, step = 5) {
  if (woodlandAt(x, z) > DEEP_WOOD) return true;
  for (let r = step; r <= radius; r += step) {
    const n = Math.max(4, Math.round((2 * Math.PI * r) / step));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      if (woodlandAt(x + Math.cos(a) * r, z + Math.sin(a) * r) > DEEP_WOOD) return true;
    }
  }
  return false;
}

/**
 * Distance to the nearest OPEN-COUNTRY road, indexed.
 *
 * The same metric `MedievalWorld._roadDist` uses - segment distance minus the
 * road's own half-width, so it is distance to the cobble EDGE - over the subset
 * of segments that are not forest track. Every road is in one class or the
 * other, so `openRoadDist(x, z) >= roadDist(x, z)` everywhere, which is what
 * makes the pair of rules in `rejectHome` a relaxation rather than a
 * contradiction.
 *
 * The returned function carries `track` and `open` counts, because "how much of
 * the network did this classify as forest" is the first question anybody
 * reading a coverage number will ask.
 *
 * @param {number[]} segs flat [ax, az, bx, bz, width] list - `world._roadSegs`
 * @param {number} [radius] canopy radius that makes a segment a forest track
 */
export function openRoadIndex(segs, radius = TRACK_CANOPY) {
  const grid = new GridIndex(24);
  let track = 0;
  let open = 0;
  for (let i = 0; i < segs.length; i += 5) {
    const ax = segs[i]; const az = segs[i + 1];
    const bx = segs[i + 2]; const bz = segs[i + 3];
    if (nearCanopy((ax + bx) * 0.5, (az + bz) * 0.5, radius)) { track++; continue; }
    open++;
    const hw = segs[i + 4] * 0.5;
    grid.insert(i, Math.min(ax, bx) - hw, Math.min(az, bz) - hw,
      Math.max(ax, bx) + hw, Math.max(az, bz) + hw);
  }
  const metric = (i, x, z) => {
    const ax = segs[i]; const az = segs[i + 1];
    const ex = segs[i + 2] - ax; const ez = segs[i + 3] - az;
    const len = ex * ex + ez * ez;
    let t = len > 1e-9 ? ((x - ax) * ex + (z - az) * ez) / len : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(x - (ax + ex * t), z - (az + ez * t)) - segs[i + 4] * 0.5;
  };
  const fn = (x, z) => {
    const d = grid.nearest(x, z, metric);
    return d === Infinity ? 1e9 : d;
  };
  fn.track = track;
  fn.open = open;
  return fn;
}

/**
 * Species written as a table rather than read from `BeastSpecies.js`.
 *
 * `BeastSpecies.js` is the authority on what an animal IS and this file must
 * not be a second copy of it - but it is also a module this one is allowed to
 * import, and it is imported: `reachFor` takes the def. What is written here is
 * only the DENSITY decision, which is a world-authoring choice and not a
 * property of the animal: how many of each the vale should hold, and in what
 * ratio.
 */
export const WILDLIFE_MIX = [
  /* Wolves outnumber bears three to one, and a wolf site is a PACK of three to
   * five - so most of the danger in the woods is the encounter the species was
   * designed around (see the note in `BeastSpecies.wolf`: the fight is about
   * the three that are not in front of you). */
  { species: 'wolf', weight: 3 },
  { species: 'bear', weight: 1 },
];

/**
 * How far from its home a beast can still acquire a target.
 *
 * THE SAME FUNCTION THE ANIMAL USES, not a second copy of it. `BeastNPC` now
 * refuses to hunt anything further from `home` than this - see
 * `BeastSpecies.threatRadius`, which this delegates to - so the cordons drawn
 * here are statements about where a wolf can BE and not only about where a
 * spec was written. Two copies of the formula would be two different worlds,
 * and the one the player meets would be the animal's.
 */
export const reachFor = threatRadius;

/* ------------------------------------------------------------------ */
/* The built extent                                                    */
/* ------------------------------------------------------------------ */

/**
 * How far outside its real geometry every shape in the union is inflated.
 *
 * This is the entire headroom of the guarantee, so it is a named constant with
 * the proof beside it rather than a `+ 1.5` in six places. Every shape below
 * contains its subject inflated by this much, so a point that clears the shape
 * by `MARGIN` clears the SUBJECT by `MARGIN + WALL_PAD` = 23.5 m.
 *
 * 1.5 and not 0 because the world's own registration is not tight either:
 * `MedievalWorld._shell` registers a footprint 1.4 m outside its walls and
 * `_house` 1.3 m, for eaves, sills and door furniture. WALL_PAD is set just
 * above both so the union is never LOOSER than what the world itself calls a
 * building. Do not trim it - the guarantee is `MARGIN + WALL_PAD`, and MARGIN
 * alone is what the old rule promised.
 */
export const WALL_PAD = 1.5;

/**
 * @typedef {{owner:string, kind:'disc', x:number, z:number, r:number}
 *         | {owner:string, kind:'rect', x:number, z:number, hx:number, hz:number}
 *         | {owner:string, kind:'seg', ax:number, az:number, bx:number, bz:number,
 *            hw:number}} BuiltShape
 */

/** True when a yaw is a quarter turn, so an oriented rect is axis-aligned. */
function axisAligned(r) {
  return Math.abs(Math.sin(r)) < 1e-9 || Math.abs(Math.cos(r)) < 1e-9;
}

/**
 * Every built thing in the vale, as shapes that contain it.
 *
 * Discs and AXIS-ALIGNED rects only - see the header for the rotated-rect
 * defect this routes around. A building becomes the disc CIRCUMSCRIBED about
 * its footprint, `hypot(w/2, d/2)`, which is rotation-invariant and therefore
 * cannot be wrong about a yaw.
 *
 * TWO SOURCES, and they cover different things:
 *
 *   the TABLES  `allBuildings()`, `PLOTS`, `EXTRA_YARDS`, `CAMPS`, `CASTLE`,
 *               `MARKET`, `CEOLWINE_PRECINCT`, `BLACKMARCH_PALISADE`,
 *               `REEDWATER_JETTIES`, `GRIMSCAR_WORKINGS`. Pure: available to a
 *               caller with no world, which is what lets the safety theorem be
 *               proved without building one. A house moved in a table moves the
 *               cordon with it and this file is not edited.
 *   `footprints` what the BUILDERS actually put down - `world._footprints`.
 *               The tables do not describe all of it and cannot: the Greyoak
 *               stage, the three bridges, the crossing ramps, Fenwick's market
 *               furniture, the castle's 18 m approach apron, St Aldern, the
 *               mills, the watchtower and the two parish churches exist only as
 *               literals inside `MedievalWorld.js`. This is the half that makes
 *               the header's list of "every building, camp, precinct wall,
 *               palisade, castle, market apron and jetty" true rather than
 *               nearly true.
 *
 * Neither source is a superset of the other, which is why both are here:
 * Grimscar's workings are in a table and in NO footprint, and the castle's
 * approach apron is in a footprint and in no table.
 *
 * A footprint record carries an ORIENTED rect, and its `r` is not written to
 * one convention: `_house` and `_shell` store the building's own yaw, while
 * `_jetty` and the crossing ramps store its negation, because they were
 * authored against `_inFootprint`, which evaluates a rotated rect with
 * cos(-r)/sin(-r) - the forward map rather than its inverse. A CIRCUMSCRIBED
 * DISC, `hypot(hx, hz)`, contains the rect under either reading, so the union
 * is right about geometry the world itself is ambiguous about. Records that
 * are axis-aligned (`r` a quarter turn - 112 of the 234, including the castle
 * apron and every bridge) keep their exact rect and pay nothing.
 *
 * `footprints` is optional so the pure half stays pure. Omit it and the union
 * is the tables alone, which is a STRICT SUBSET: adding shapes can only push a
 * legal home further from a wall, never nearer, so the theorem proved over the
 * table-only union holds over the shipped one too.
 *
 * @param {Array} [settlements]
 * @param {Array<{x:number,z:number,hx:number,hz:number,r:number}>} [footprints]
 * @returns {BuiltShape[]}
 */
export function builtShapes(settlements = SETTLEMENTS, footprints = null) {
  const out = [];
  const disc = (owner, x, z, r) => out.push({ owner, kind: 'disc', x, z, r: r + WALL_PAD });
  const rect = (owner, x, z, hx, hz) =>
    out.push({ owner, kind: 'rect', x, z, hx: hx + WALL_PAD, hz: hz + WALL_PAD });

  /* 1. Every town building, circumscribed. */
  for (const b of allBuildings()) disc(b.town, b.x, b.z, Math.hypot(b.w / 2, b.d / 2));
  /* 2. Every vale dwelling, and the two hand-placed yards (tavern, mill). */
  for (const p of PLOTS) disc('aldermoor-plots', p[0], p[1], Math.hypot(p[3] / 2, p[4] / 2));
  for (const e of EXTRA_YARDS) disc('extra-yard', e.x, e.z, Math.hypot(e.w / 2, e.d / 2));
  /* 3. Every camp, as its own working radius. `Camps` declares that radius as
   *    the thing every piece fits inside, and the gate asserts it - the same
   *    containment `medieval-towns.test.mjs` asserts for a town's radius. */
  for (const c of CAMPS) disc(c.id, c.x, c.z, c.radius);
  /* 4. The authored things that are not buildings. */
  rect('st-ceolwine', CEOLWINE_PRECINCT.x, CEOLWINE_PRECINCT.z,
    CEOLWINE_PRECINCT.hx, CEOLWINE_PRECINCT.hz);
  const P = BLACKMARCH_PALISADE;
  rect('blackmarch', (P.x0 + P.x1) / 2, (P.z0 + P.z1) / 2,
    (P.x1 - P.x0) / 2, (P.z1 - P.z0) / 2);
  rect('aldermoor-keep', CASTLE.x, CASTLE.z, CASTLE.hx, CASTLE.hz);
  rect('aldermoor', MARKET.x, MARKET.z, MARKET.hx, MARKET.hz);
  for (const j of REEDWATER_JETTIES) {
    for (let i = 0; i < j.pts.length - 1; i++) {
      out.push({
        owner: 'reedwater', kind: 'seg',
        ax: j.pts[i][0], az: j.pts[i][1], bx: j.pts[i + 1][0], bz: j.pts[i + 1][1],
        hw: j.w * 0.5 + WALL_PAD,
      });
    }
  }
  /* 4b. Grimscar's workings, which NEITHER source above reaches.
   *
   * `_dressGrimscar` registers no footprint for any of it - not the headframe,
   * not the adit, not the tramway, not the tip - so folding `world._footprints`
   * into the union does nothing for the only mine in the world. Measured before
   * this rule went in: every one of the fourteen subjects below sat OUTSIDE the
   * union, the tramway's sixth point by 2.1 m at its centre and the tip's outer
   * edge by 12.2 m.
   *
   * Each radius contains what the renderer draws, and is written with the
   * literal it comes from rather than chosen:
   *
   *   adit       8 m. The retaining walls stand 4.1 m either side of the
   *              centreline and the drainage launder runs to 7.5 m east of the
   *              mouth: hypot(7.5, 2.45) = 7.89.
   *   headframe  4.5 m, which is the radius `_dressGrimscar` itself pushes to
   *              `_contacts` for it. The legs' own corner is legHalf * sqrt(2)
   *              = 4.38.
   *   spoil      r * 1.35 + 0.5. The cone is perlin-warped out to 1.22 r and
   *              the loose shale skirting its foot is scattered to
   *              `r * (0.85 + rnd() * 0.5)`, each piece a block up to 0.5 m
   *              across.
   *   tramway    1.5 m either side of the centreline: 0.75 m of sleeper, and
   *              two standing ore carts whose furthest corner is 1.14 m off it.
   *
   * NOT covered, and stated rather than papered over: the pit props, stacked
   * timber and water butt scattered over (-376..-370, -204..-196) are literals
   * in `_dressGrimscar` with no table entry and no footprint, so nothing here
   * can reach them. The proper fix is a `_footprints.push` in that builder, at
   * which point rule 6 picks them up for free. `medieval-wildlife.test.mjs`
   * measures what the shipped placement actually leaves them. */
  const GW = GRIMSCAR_WORKINGS;
  disc('grimscar', GW.adit.x, GW.adit.z, 8);
  disc('grimscar', GW.headframe.x, GW.headframe.z, 4.5);
  for (const h of [...GW.heaps, GW.tip]) disc('grimscar', h.x, h.z, h.r * 1.35 + 0.5);
  for (let i = 0; i < GW.tramway.length - 1; i++) {
    out.push({
      owner: 'grimscar', kind: 'seg',
      ax: GW.tramway[i][0], az: GW.tramway[i][1],
      bx: GW.tramway[i + 1][0], bz: GW.tramway[i + 1][1],
      hw: 1.5 + WALL_PAD,
    });
  }
  /* 5. Everything the four rules above do not name, as its spacing radius. */
  const named = new Set([
    'aldermoor', 'keep-approach', 'aldermoor-keep',
    ...TOWNS.map((t) => t.id), ...CAMPS.map((c) => c.id),
  ]);
  for (const s of settlements) {
    if (!s?.centre || named.has(s.id)) continue;
    disc(s.id, s.centre.x, s.centre.z, s.radius ?? 0);
  }
  /* 6. And everything the world registered that no table describes. */
  for (const f of footprints ?? []) {
    const r = f.r ?? 0;
    if (axisAligned(r)) {
      const flip = Math.abs(Math.cos(r)) < 1e-9;
      rect('registered', f.x, f.z, flip ? f.hz : f.hx, flip ? f.hx : f.hz);
    } else {
      disc('registered', f.x, f.z, Math.hypot(f.hx, f.hz));
    }
  }
  return out;
}

/** Signed distance from (x, z) to one shape, negative inside. */
export function shapeDistance(s, x, z) {
  if (s.kind === 'disc') return Math.hypot(x - s.x, z - s.z) - s.r;
  if (s.kind === 'rect') return rectDist(x - s.x, z - s.z, s.hx, s.hz);
  const ex = s.bx - s.ax;
  const ez = s.bz - s.az;
  const len = ex * ex + ez * ez;
  let t = len > 1e-9 ? ((x - s.ax) * ex + (z - s.az) * ez) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(x - (s.ax + ex * t), z - (s.az + ez * t)) - s.hw;
}

/**
 * The union, indexed.
 *
 * The union is 156 shapes from the tables alone and 390 with the world's
 * registered footprints folded in, and `planBeasts` asks it once per dart, so
 * it goes through `GridIndex` - the repo's own exact-nearest index, the same
 * one `_roadDist` uses, rather than a second one written here.
 *
 * Memoised on BOTH source arrays' identity, so the world and the gate each
 * build it once and a caller that asks for the pure union never gets handed
 * the one that has the world's footprints in it, or the other way round.
 */
let BUILT_CACHE = null;
export function builtIndex(settlements = SETTLEMENTS, footprints = null) {
  if (BUILT_CACHE && BUILT_CACHE.src === settlements && BUILT_CACHE.fps === footprints) {
    return BUILT_CACHE.index;
  }
  const shapes = builtShapes(settlements, footprints);
  const grid = new GridIndex(32);
  for (let i = 0; i < shapes.length; i++) {
    const s = shapes[i];
    let minX; let minZ; let maxX; let maxZ;
    if (s.kind === 'disc') {
      minX = s.x - s.r; maxX = s.x + s.r; minZ = s.z - s.r; maxZ = s.z + s.r;
    } else if (s.kind === 'rect') {
      minX = s.x - s.hx; maxX = s.x + s.hx; minZ = s.z - s.hz; maxZ = s.z + s.hz;
    } else {
      minX = Math.min(s.ax, s.bx) - s.hw; maxX = Math.max(s.ax, s.bx) + s.hw;
      minZ = Math.min(s.az, s.bz) - s.hw; maxZ = Math.max(s.az, s.bz) + s.hw;
    }
    grid.insert(i, minX, minZ, maxX, maxZ);
  }
  /* The owner is tracked inside the metric rather than found by a second,
   * linear pass. `GridIndex.nearest` prunes cells, but it necessarily EVALUATES
   * the shape that achieves the minimum, so the running minimum kept here sees
   * the same winner the index returns. A separate linear scan for the name cost
   * 40% of the dart budget, because a rejection is the common case. */
  let bestSeen = Infinity;
  let bestOwner = null;
  const distTo = (i, x, z) => {
    const d = shapeDistance(shapes[i], x, z);
    if (d < bestSeen) { bestSeen = d; bestOwner = shapes[i].owner; }
    return d;
  };
  const index = {
    shapes,
    /** Distance to the nearest built thing, negative inside one. */
    distance(x, z) {
      bestSeen = Infinity;
      bestOwner = null;
      return grid.nearest(x, z, distTo);
    },
    /** Same, plus which settlement owns it - the diagnostic half. */
    nearest(x, z) {
      const d = index.distance(x, z);
      return { d, owner: bestOwner };
    },
  };
  BUILT_CACHE = { src: settlements, fps: footprints, index };
  return index;
}

/**
 * Distance from a point to the nearest built thing in the vale, in metres.
 *
 * Negative inside one. Exported because "how close did a pack get to the actual
 * buildings" is the question a safety review asks, and because the gate has to
 * be able to ask it without re-deriving the union.
 */
export function builtDistance(x, z, settlements = SETTLEMENTS, footprints = null) {
  return builtIndex(settlements, footprints).distance(x, z);
}

/* ------------------------------------------------------------------ */
/* Regions                                                             */
/* ------------------------------------------------------------------ */

/**
 * The original 400 m vale: where the player spawns, and where the castle, the
 * village, the market and the riverside content are.
 *
 * A box rather than a disc because that is what the rest of the codebase means
 * by it - `Camps.js` moves a camp specifically to keep its beaten earth out of
 * `|x|, |z| <= 200`, and `medieval-settled.test.mjs` enumerates that square.
 * The eastern wood that can hold a bear sits at (188..200, -120..-104), whose
 * corner is 225 m from the origin, so a 200 m DISC would exclude content this
 * region exists to place.
 */
export const CORE_VALE = { id: 'core-vale', x: 0, z: 0, hx: 200, hz: 200 };

/**
 * Per-region minimums, filled before the global nearest-a-road deal.
 *
 * One entry, and one pack.
 *
 * ONE ENTRY because the core vale is the only region whose emptiness a player
 * has ever reported, and a quota is a promise the dart pool has to be able to
 * keep. TWO PACKS is now attainable where it once was not - the vale holds 39
 * legal wolf homes and 142 legal bear homes since Hazelbrake, against 0 and 12
 * before it - so this is a choice rather than a limit, and the reason it stays
 * at one is that the second pack is not worth forcing: every extra core-vale
 * home is either inside Hazelbrake, which `minApart` already closes to a second
 * pack, or on the eastern rim at (188..200, -120..-104), which is over 160 m
 * from the nearest core-vale road node and therefore streamed and never drawn.
 * The shipped placement puts a bear on that rim anyway - at (204.7, -105.6),
 * five metres outside the box - by the global deal on its own merit.
 *
 * What the quota is actually for is DETERMINISM, and the four-corner table in
 * the header is honest about how little else it buys now: a first-legal-dart
 * placement also finds Hazelbrake, because Hazelbrake is large and near. The
 * difference is that the quota finds it every build, and the dart finds it
 * until the day a road moves or the roster shifts by one civilian.
 */
export const REGIONS = [{ ...CORE_VALE, min: 1 }];

/** True when (x, z) is inside a region's box. */
export function inRegion(rg, x, z) {
  return Math.abs(x - rg.x) <= rg.hx && Math.abs(z - rg.z) <= rg.hz;
}

/**
 * Everything a candidate home has to clear, as one predicate.
 *
 * Returns the NAME of the first rule that rejected, or null when the spot is
 * good. A string rather than a boolean because the test asserts on the reasons
 * and the world's summary reports them: "no site found" is a bug report with no
 * information in it.
 *
 * @param {number} x
 * @param {number} z
 * @param {number} reach
 * @param {object} ctx
 * @returns {string|null}
 */
export function rejectHome(x, z, reach, ctx) {
  const {
    settlements = SETTLEMENTS,
    built = null,
    footprints = null,
    people = [],
    height = medievalHeight,
    roadDist = null,
    openRoadDist = null,
    slope = null,
    inset = 30,
  } = ctx ?? {};

  if (!(x > -HALF + inset && x < HALF - inset && z > -HALF + inset && z < HALF - inset)) return 'playfield';

  const y = height(x, z);
  if (y < WATER_Y + 1.2) return 'water';
  if (Math.abs(z - riverZ(x)) < riverHalfWidth(x) + 14) return 'channel';

  /* The built and people rules are tested BEFORE the woodland mask even though
   * the mask is cheaper and rejects more darts, and the reason is diagnosis
   * rather than speed. `planBeasts` reports which rule turned each dart away; a
   * barren map has to be able to say "every wood is inside somebody's cordon",
   * and it cannot say that if the cordon test never runs. */
  const clear = reach + MARGIN;
  const index = built ?? builtIndex(settlements, footprints);
  const near = index.nearest(x, z);
  if (near.d < clear) return `built:${near.owner}`;
  for (const p of people) {
    if ((x - p.x) ** 2 + (z - p.z) ** 2 < clear * clear) return 'people';
  }
  /* TWO road rules, because there are two kinds of road.
   *
   * `openRoadDist` measures only the stretches that are NOT forest track, so it
   * is never smaller than `roadDist` and the pair is a relaxation of the single
   * rule it replaces rather than a contradiction of it. Omit it and every road
   * is a highway, which is exactly the old behaviour - that is the ablation the
   * gate replays. */
  if (roadDist) {
    const open = openRoadDist ?? roadDist;
    if (open(x, z) < reach * ROAD_SHARE + MARGIN) return 'road';
    if (roadDist(x, z) < reach * TRACK_SHARE + TRACK_MARGIN) return 'track';
  }

  if (woodlandAt(x, z) <= DEEP_WOOD) return 'woodland';
  if (slope && slope(x, z) > 0.55) return 'slope';
  return null;
}

/**
 * Plan the vale's predator sites.
 *
 * Returns HOMES, not animals: one record is one pack, which is the unit
 * `NPCManager.spawnBeastGroup` and `Residency` both think in, and the unit the
 * design is expressed in ("a pack lives in the north woods").
 *
 * Sites are darted rather than laid out, because the woodland mask is noise and
 * there is no closed form for "inside it". The dart stream is seeded off a
 * fixed string, so the same map always grows the same wolves - determinism here
 * is not a nicety, it is what makes the placement testable at all.
 *
 * The darts choose a POOL, not the sites. A uniform dart that takes the first
 * legal spot it hits picks in proportion to legal AREA, and legal area is
 * mostly the empty outer rim. Sites come out of the pool nearest-a-road-first,
 * after each region in `regions` has taken its minimum from its own share of
 * it. Nothing about legality changes - the pool is exactly the darts
 * `rejectHome` accepted.
 *
 * When no `roadDist` is supplied there is nothing to sort against, and the pool
 * is consumed in dart order - i.e. the old behaviour, for a caller that has no
 * road network to speak of.
 *
 * The return carries three diagnostics, and their arithmetic is checked by the
 * gate rather than trusted:
 *
 *   `reasons`  why each DART died. `sum(reasons) + pool.size === tries`,
 *              exactly. It used to carry `apart`, which counted pool-SCAN
 *              skips and broke that identity by thousands.
 *   `pool`     `{ size, nearRoad, crowded, exhausted }` - the shape of the pool
 *              the deal ran over. `nearRoad` is the count within 110 m of a
 *              road, which is the number that actually decides whether `tries`
 *              is high enough.
 *   `regions`  `[{ id, want, got }]`, so a quota that cannot be met says so.
 *
 * @param {object} ctx
 * @param {(id:string)=>object} ctx.beastDef  usually `BeastSpecies.beastDef`
 * @param {number} [ctx.count] how many sites to plan
 * @param {number} [ctx.tries] darts thrown into the pool
 * @param {Array<{x:number,z:number}>} [ctx.people] every civilian position
 * @param {Array<{x:number,z:number,hx:number,hz:number,r:number}>} [ctx.footprints]
 *        `world._footprints`, so the cordon covers what the builders put down
 *        as well as what the tables describe
 * @param {(x:number,z:number)=>number} [ctx.roadDist] distance to any road
 * @param {(x:number,z:number)=>number} [ctx.openRoadDist] distance to the
 *        stretches that are NOT forest track - `openRoadIndex(world._roadSegs)`.
 *        Omit it and every road is a highway, i.e. the pre-track behaviour.
 * @param {(x:number,z:number)=>number} [ctx.slope]
 * @param {Array<{id:string,x:number,z:number,hx:number,hz:number,min:number}>} [ctx.regions]
 * @returns {Array<{x:number,y:number,z:number,species:string,territory:number,
 *                  reach:number,wood:number}>}
 */
export function planBeasts(ctx = {}) {
  const {
    beastDef,
    count = 12,
    height = medievalHeight,
    /* UNCHANGED, and that is the finding rather than an oversight.
     *
     * A pool has to be dense enough to CONTAIN the roadside woods rather than
     * merely to find twelve legal spots, so the number was re-measured from
     * scratch on the shipped configuration, and re-measured again after
     * `Woodland.AUTHORED_WOODS` added Hazelbrake. There is no knee above 5,000:
     *
     *   tries    pool  nearRoad   band   enc   nodes@175   sites
     *    2,000      95        19   5.4%  1.8%      63.9%   12
     *    5,000     226        50  15.3%  4.0%      73.8%   12
     *   20,000     861       214  22.8%  7.1%      77.0%   12
     *   40,000   1,680       422  22.5%  7.7%      77.0%   12
     *
     * Everything above 5,000 is the same map. 20,000 is kept because it is ten
     * times the point at which the pool starves and costs 47.1 ms of
     * synchronous main-thread work at the end of the world build (best of three,
     * one call, production inputs). Classifying the 1,259 road segments into
     * track and highway is a further 14.5 ms, paid once, in `openRoadIndex`.
     * 40,000 would buy 0.6 points of ENCOUNTER for another 47 ms, and would
     * lose 0.3 of the roadside band.
     *
     * THE STARVATION SIGNATURE MOVED when the wood went in, and this is where
     * it is written down. At 2,000 darts the core-vale quota used to go UNFILLED
     * and the count came up short at eleven; it no longer does, because
     * Hazelbrake is 2,064 m2 of legal ground and a thin pool still finds it.
     * What 2,000 darts now costs is coverage: the roadside canopy band falls to
     * 5.4% against a 15% floor and ENCOUNTER to 1.8% against a 5% floor, both
     * of which fail outright. `out.pool.nearRoad` is reported alongside them so
     * a starved pool is diagnosed directly instead of being inferred from
     * coverage. A legitimate road re-route cannot fail those floors by accident
     * and a halved dart budget does. */
    tries = 20000,
    minApart = 90,
    roadDist = null,
    regions = REGIONS,
  } = ctx;
  if (typeof beastDef !== 'function') throw new TypeError('planBeasts needs ctx.beastDef');

  /* The mix expanded into a repeating deal, so the ratio in `WILDLIFE_MIX` is
   * what the map actually gets rather than what a per-dart coin flip converges
   * to - at twelve sites a 3:1 coin flip lands on 12:0 often enough to matter.
   * Interleaved rather than blocked (wolf wolf wolf bear ...), so a `count`
   * that is cut short by a budget still carries both species. */
  const template = [];
  for (const m of WILDLIFE_MIX) for (let i = 0; i < m.weight; i++) template.push(m.species);
  const deal = [];
  for (let i = 0; i < count; i++) deal.push(template[i % template.length]);

  /* Legality is per SPECIES, not per dart: a bear reaches 52 m and a wolf 68,
   * so a wood that is legal for one can be inside the other's road clearance.
   *
   * NARROWEST reach first, and that ordering is load-bearing twice over. Every
   * clearance in `rejectHome` is `reach + MARGIN` or `reach * ROAD_SHARE +
   * MARGIN`, both strictly increasing in `reach`, and the rest of the rules do
   * not mention it - so legality is MONOTONE: a point the narrowest species
   * cannot use, none can. That lets the loop stop at the first refusal, which
   * costs one evaluation for the ~96% of darts nothing can use instead of one
   * per species, and it makes the reported reason the reason the SMALLEST
   * animal was turned away, which is the strongest thing a barren map can say
   * about a patch of ground. */
  const species = [...new Set(deal)]
    .map((id) => ({ id, def: beastDef(id), reach: reachFor(beastDef(id)) }))
    .sort((a, b) => a.reach - b.reach);

  /* One index for the whole call, rather than one per `rejectHome`.
   *
   * `ctx.footprints` is `world._footprints` when the world plans, and absent
   * when a caller with no world does. The array is FINAL by then: the last
   * push is `MedievalWorld._buildLandmarks` and `applyMedievalPopulation` runs
   * strictly later, out of `_buildInhabitants`. The gate asserts the count so
   * a builder added after this one cannot quietly plan against a short list. */
  const built = builtIndex(ctx.settlements ?? SETTLEMENTS, ctx.footprints ?? null);
  const dartCtx = { ...ctx, built };

  const rnd = streamFor('medieval:wildlife');
  const reasons = Object.create(null);

  /* ---- the pool: every legal home the darts found ------------------- */
  const pool = [];
  for (let t = 0; t < tries; t++) {
    const x = (rnd() - 0.5) * 2 * HALF;
    const z = (rnd() - 0.5) * 2 * HALF;
    let ok = 0;
    let why = null;
    for (let i = 0; i < species.length; i++) {
      const w = rejectHome(x, z, species[i].reach, dartCtx);
      if (w) { why = w; break; }
      ok |= 1 << i;
    }
    if (!ok) { reasons[why] = (reasons[why] ?? 0) + 1; continue; }
    pool.push({ x, z, ok, road: roadDist ? roadDist(x, z) : 0, taken: false });
  }
  /* Nearest a road first. The x/z tie-breaks are not decoration: two darts can
   * share a road distance to the last bit, and a sort whose order depends on
   * the engine's sort stability is a sort that can move a wolf pack between
   * runs of the same seed. */
  if (roadDist) pool.sort((a, b) => (a.road - b.road) || (a.x - b.x) || (a.z - b.z));

  const out = [];
  const stats = { size: pool.length, nearRoad: 0, crowded: 0, exhausted: 0 };
  for (const c of pool) if (c.road <= 110) stats.nearRoad++;

  /** The first untaken candidate the species can use, `minApart` from the rest. */
  const claim = (bit, within) => {
    for (let k = 0; k < pool.length; k++) {
      const c = pool[k];
      if (c.taken || !(c.ok & bit)) continue;
      if (within && !inRegion(within, c.x, c.z)) continue;
      /* Packs spread out from each other as well as from people. Two wolf packs
       * sharing a wood is four to ten wolves converging on one player, which is
       * not the encounter either pack was tuned for. */
      let clash = false;
      for (const o of out) {
        if ((o.x - c.x) ** 2 + (o.z - c.z) ** 2 < minApart * minApart) { clash = true; break; }
      }
      if (clash) { stats.crowded++; continue; }
      return c;
    }
    return null;
  };

  const filled = new Array(count).fill(null);
  const place = (i, c) => {
    c.taken = true;
    const sp = species.findIndex((s) => s.id === deal[i]);
    filled[i] = {
      x: c.x, y: height(c.x, c.z), z: c.z,
      species: deal[i],
      territory: species[sp].def.territory,
      reach: species[sp].reach,
      wood: woodlandAt(c.x, c.z),
    };
    out.push(filled[i]);
  };

  /* ---- regional minimums first ------------------------------------- */
  const regionReport = [];
  for (const rg of regions ?? []) {
    let got = 0;
    for (let want = rg.min ?? 0; got < want;) {
      /* Which SLOT gets it is decided by what the region can hold, not by the
       * deal order. That mattered absolutely before Hazelbrake, when the core
       * vale had no legal wolf home at all and a quota insisting on the next
       * slot in sequence would have placed nothing; it still matters, because
       * a region CAN be bear-only and the wolf slots come first in the deal.
       * The mix itself is untouched - a slot is still one entry of `deal`. */
      let placed = false;
      for (let i = 0; i < count; i++) {
        if (filled[i]) continue;
        const sp = species.findIndex((s) => s.id === deal[i]);
        const c = claim(1 << sp, rg);
        if (!c) continue;
        place(i, c);
        placed = true;
        got++;
        break;
      }
      if (!placed) break;
    }
    regionReport.push({ id: rg.id, want: rg.min ?? 0, got });
  }

  /* ---- then the global deal, nearest a road first ------------------- */
  for (let i = 0; i < count; i++) {
    if (filled[i]) continue;
    const sp = species.findIndex((s) => s.id === deal[i]);
    const c = claim(1 << sp, null);
    /* No legal home left for this species that is far enough from the ones
     * already placed. Reported rather than retried under a different species,
     * because a short count with a named reason is a bug report and a silently
     * rebalanced mix is not. */
    if (!c) { stats.exhausted++; continue; }
    place(i, c);
  }

  /* `out` is in the order the sites were CLAIMED, which puts the regional
   * picks first. Re-ordered to the deal so the return reads as the roster it
   * is, and so two runs of the same seed are identical element for element. */
  out.length = 0;
  for (const f of filled) if (f) out.push(f);
  out.reasons = reasons;
  out.pool = stats;
  out.regions = regionReport;
  return out;
}
