import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as THREE from 'three';

import { buildStation, logLine } from './world-kit.mjs';
import { MapOverlay } from '../../src/systems/MapOverlay.js';
import { planGrid, MAX_LAYERS, LAYOUT_SCHEMA } from '../../src/systems/GroundSampler.js';
import { WORLD_R, DOME_APEX } from '../../src/worlds/station/StationKit.js';

/**
 * THE STATION'S EDITOR ADDRESS SPACE, PINNED.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHAT THIS GUARDS, AND WHY NOTHING GUARDED IT BEFORE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The admin map editor addresses station objects BY NAME. A saved document
 * carries `target: { name: 'dressing:crate' }`, the applier resolves it with a
 * single `world.group.getObjectByName(name)`, and a miss is pushed as reason
 * `name` and skipped - silently, as far as the world is concerned
 * (`MapOverlay.js` `_applyMove` / `_applyRemove`).
 *
 * Those names are minted by `StationKit.flush` as `${flushLabel}:${materialKey}`
 * and a bucket only produces a name when it is non-empty (`if (!list.length)
 * continue;`). So the SET OF ADDRESSES THE EDITOR CAN USE is a pure function of
 * which material buckets each builder happens to emit - and the placement
 * re-plan re-authors exactly those builders.
 *
 * Nothing versioned that set and nothing tested it. The applier's own suite
 * (`map-overlay.test.mjs`) runs against a synthetic three-object world named
 * 'station', so it would pass a redesign that renamed every real object in the
 * world. This file is the pin that would not.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  WHY POSITIONS AND NOT ONLY NAMES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * A move lands the object's ANCHOR - the world bottom-centre of
 * `Box3.setFromObject` - at the saved position, and the delta is
 * `to - anchorBefore`. For a merged batch that box is the union of every piece
 * of that material key in the district, so adding or dropping the single most
 * extreme piece shifts the anchor and the SAME saved entry translates by a
 * different vector than the admin ever dragged. The row still reports
 * `ok: true`.
 *
 * A name-only pin is blind to that: it reads identical whether the dressing
 * anchors moved a millimetre or thirty metres. So the fixture stores
 * `{name, position}` and this file diffs both.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  IS A HEADLESS PIN THE REAL ONE?
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Asked and answered by measurement rather than argument, because the harness
 * stubs canvas and resolves the hero and crowd asset loaders to empty maps -
 * so a pin taken here could easily have been a pin on a DIFFERENT name set.
 *
 * Diffed against the catalogue production actually stored (`map_world_reports`,
 * world_id 'station', 756 objects, reported 2026-08-29): **756 names in both,
 * none only in one, and not one anchor differing by more than a millimetre.**
 * The textures are black squares headless and the crowd is procedural, and
 * neither of those is a named node or moves one. The pin is the real address
 * space. Re-run `.probe/catalogue-diff.mjs` to re-check that claim.
 *
 * That diff was taken BEFORE Phase 1 and is the reason its renames could be
 * made confidently. It will now report differences until an admin next enters
 * the station and the report is re-taken, and those differences are exactly
 * the ones this file's fixture records: 180 coordinate-baked names replaced by
 * label-slugged ones, and 12 rows withheld (eleven `StationActors:*` plus
 * `ramp-proxy`). 756 in production, 744 here. Nothing is broken by the gap -
 * production held no name-targeted entry in any version of any world, checked
 * against `map_overlays` before the renames were written.
 *
 * To re-take the fixture after an INTENDED rename:
 *     STATION_CATALOGUE_UPDATE=1 node --test scripts/tests/station-catalogue.test.mjs
 * and put the resulting diff in the commit message. That diff is the gate.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'station-catalogue.json');
const UPDATE = process.env.STATION_CATALOGUE_UPDATE === '1';

/** Millimetre agreement. Anything the re-plan could do to an anchor is metres. */
const POS_TOL = 0.001;

let _cat = null;
async function catalogue() {
  if (_cat) return _cat;
  const { world } = await buildStation();
  // The real method, called the way the report path calls it. Not a copy:
  // a re-implementation here would pin this file's idea of the catalogue.
  _cat = new MapOverlay({})._catalogue(world);
  return _cat;
}

test('the catalogue fits inside the cap that truncates it silently', async () => {
  const cat = await catalogue();
  /* Both sides cap at 2000 and both truncate breadth-first, so client and
   * server agree on the same wrong answer and nothing is reported: no reason,
   * no warning, no unresolved row. The footer just reads 2000. */
  console.log(`  catalogue: ${cat.length} named objects (cap 2000)`);
  assert.ok(cat.length > 0, 'the station reported no named objects at all');
  assert.ok(cat.length < 2000, `catalogue is ${cat.length}, at or over the 2000 cap - objects are being dropped with no error anywhere`);
  assert.ok(cat.length < 1900, `catalogue is ${cat.length}, inside 100 of the cap - budget the headroom before adding more names`);
});

test('no two nodes IN THE WORLD share a name', async () => {
  const { world } = await buildStation();

  /* Asserted over the world, not over the catalogue.
   *
   * `_catalogue`'s output is unique BY CONSTRUCTION - it adds to a `seen` Set
   * before pushing - so asserting on it can only fail if that Set is deleted,
   * and it is blind to the risk that actually matters here. Slugging a name
   * from an authored label is precisely the kind of change that can mint the
   * same string twice, and when it does the catalogue silently keeps the
   * SHALLOWEST while the applier resolves depth-first with `getObjectByName`:
   * the editor then shows and positions one node and moves a different one,
   * reporting ok: true.
   *
   * `ramp-proxy` is the one name deliberately shared by many nodes - it is a
   * collision proxy, withheld from the picker for exactly this reason - so it
   * is allowed by name rather than by silence. */
  const SHARED_BY_DESIGN = new Set(['ramp-proxy']);
  const counts = new Map();
  world.group.traverse((o) => {
    const n = typeof o.name === 'string' ? o.name.trim() : '';
    if (!n || SHARED_BY_DESIGN.has(n)) return;
    counts.set(n, (counts.get(n) ?? 0) + 1);
  });
  const dupes = [...counts].filter(([, n]) => n > 1).map(([k, n]) => `${k} x${n}`);
  assert.deepEqual(dupes, [], `names shared by more than one node: ${dupes.join(', ')}`);
});

test('the collision the world derives from its own geometry is unchanged', async () => {
  const { log, physics } = await buildStation();

  /* The one change in this phase that COULD alter what a player walks through
   * was the removal of a fallback in `_collisionSoup` that let a mesh NAME
   * decide a material key. It was argued to be unreachable and measured to be
   * a no-op - and then the measurement was a human reading one console line,
   * which is exactly the kind of evidence this repo has learned not to trust.
   *
   * So the line is the gate. Every figure in it is load-bearing: `triangles
   * found` is counted BEFORE anything is dropped, so it proves no geometry
   * entered or left the pass; `kept` and `chunks` prove the drop and the
   * chunker agree; `planting proxies` proves `_solidifyPlanting`'s separate
   * predicate still selects the same set. The collider total covers the box
   * passes the line says nothing about.
   *
   * If a deliberate change moves these, re-take them in the same commit and
   * say which figure moved and why. A silent edit here is a walk-through. */
  const line = logLine(log, 'structure collided from geometry');
  assert.ok(line, 'the build no longer reports its structure collision - the gate cannot see anything');
  console.log(`  ${line.trim()}`);

  const nums = line.match(/(\d+) triangles found, (\d+) already inside a box, (\d+) kept in (\d+) chunks .*?(\d+) planting proxies/);
  assert.ok(nums, `could not parse the structure line: ${line}`);
  const [, found, boxed, kept, chunks, planting] = nums.map(Number);
  /* The TRIANGLE figures are the invariant and must never move without a
   * stated reason: they are what a player walks into. `chunks` is an
   * implementation detail of how those triangles are packed into colliders,
   * and Phase 2 moved it deliberately - chunking PER OWNER rather than in one
   * global median split, so no collider mixes two objects' geometry. It went
   * DOWN, 8192 -> 8038, because a spatially coherent owner packs better than
   * an arbitrary median slice; the 401 partial chunks that per-owner splitting
   * costs are more than paid for. `physics.colliders` follows chunks exactly
   * (26352 -> 26198, the same 154).
   *
   * ── Re-taken: the gateway flanks moved off the carriageways ─────────────
   * 328702 -> 364575 found, 144631 -> 166927 boxed, 184071 -> 197648 kept,
   * 8038 -> 8605 chunks, 26198 -> 26761 colliders. Deliberate, owner-approved,
   * and it is THREE BUILDINGS rather than a change to any existing one.
   *
   * Note the collider total no longer tracks chunks exactly: +567 chunks but
   * +563 colliders. The old note above said it "follows chunks exactly", which
   * was true of Phase 2's change and is not a law - four of the new chunks
   * carry no box of their own. Both figures are measured, not derived.
   *
   * `_buildSkyline` places the gateway backdrop flanks at `base +- 25`, and
   * with roads every 60 degrees and bases at 90 and 270 that is five degrees
   * off a carriageway for all four - 9.94 m of perpendicular offset at r = 114
   * for a block reaching 13 m, so each one crosses the centreline of an 18 m
   * road. Reported live: "a large multi storey building that goes halfway into
   * the road". They are now nudged clear in two-degree steps.
   *
   * The +11% is the honest price and it is worth stating why it is a RISE for
   * a fix that moves things. Three of the four flanks were being dropped for a
   * second reason - they clashed with the habitat stacks - so once they step
   * off the avenue they stop clashing and build, which is what the loop always
   * intended ("the portal still reads against architecture from the plaza").
   * The skyline gains 44,498 triangles of its own and the rest follows.
   *
   * Nudged rather than skipped for a reason worth keeping: `rng` is ONE seeded
   * stream shared by every block in that loop, so a `continue` does not remove
   * one building, it re-rolls every building after it. Measured, a single
   * `continue` there cost 348315 found - a 6% RISE for a change meant to
   * delete geometry.
   *
   * ── And again, seven triangles, for the settle footprint fix ────────────
   * 166927 -> 166934 boxed, 197648 -> 197641 kept, `found` unchanged. Sixteen
   * dressing props stopped climbing onto planter and bench rims and now stand
   * on the deck, so seven of their triangles fall inside an authored box that
   * they used to sit above. Nothing entered or left the pass, which is what
   * `found` holding still proves.
   *
   * ── And again, for the mirrored-rect fix ────────────────────────────────
   * 364575 -> 363921 found, 166934 -> 166292 boxed, 8605 -> 8604 chunks. The
   * skyline's carriageway guard calls `StationPlan.roleUnder`, which confirms
   * through `_rectCovers` - so correcting that sign changed which gateway
   * flanks get nudged clear and by how much. A plan fix reaching the world's
   * collision is exactly what the guard being wired up MEANS; it is not a
   * surprise, and `found` moving by 654 out of 364,575 is the size of it.
   *
   * Colliders 26761 -> 26772: `_solidifyProps`
   * boxes a prop from where it ends up, and a prop that stops standing on a
   * rim is boxed separately from the rim it used to share a column with.
   *
   * ── Re-taken: the backdrop stopped standing on the station ─────────────
   * 363921 -> 368736 found, 166292 -> 170349 boxed, 197629 -> 198387 kept,
   * 8604 -> 8617 chunks. KEPT is the figure that matters and it rose 758,
   * 0.38%, for a change that moved thirteen of the sixteen backdrop blocks.
   * It rose at all because a block buried inside a habitat tower had its
   * triangles counted as ALREADY INSIDE A BOX; standing in open air they are
   * surfaces a player can walk into, so they have to be kept. That is the
   * cost of the blocks being somewhere real, and it is the cheap direction:
   * 1,008 pieces of the station stopped being inside scenery for 758
   * triangles.
   *
   * -- Re-taken again: the plan learned about axis-aligned solids ----------
   * 170349 -> 170273 boxed, 198387 -> 198463 kept; found and chunks
   * unchanged. `_solid` began claiming into the plan, which moved seven more
   * backdrop blocks off the station (16 -> 9 pieces swallowed), and 76
   * triangles that had been inside a box are now surfaces. Same direction and
   * same reason as the entry above.
   *
   * -- Re-taken: the near-field scatter stopped landing on structure --------
   * 368736 -> 369368 found, 170273 -> 169701 boxed, 198463 -> 199667 kept,
   * 8617 -> 8785 chunks. `_buildNearField`'s scatter loop gained the
   * occupancy test its two sibling loops in the same pass have always had, so
   * props no longer stand in planters and on plinths.
   *
   * Kept collision ROSE 1,204, and the direction is the tell: a prop half
   * sunk into a planter had the buried half counted as ALREADY INSIDE A BOX,
   * and standing clear it contributes its whole surface. The same arithmetic
   * as the backdrop entry above, one scale down. 1,204 triangles for eight of
   * the eighteen real dressing-inside-structure defects.
   */
  assert.deepEqual(
    { found, boxed, kept, planting },
    { found: 369218, boxed: 169620, kept: 199598, planting: 1360 },
    'the geometry-derived collision changed - these are the triangles a player walks into'
  );
  assert.equal(chunks, 8776, 'the chunking changed');
  /* 26771 -> 26940 on 2026-08-30, +169, with the near-field occupancy nudge.
   * A prop that stood inside a planter shared a collision column with it and
   * was boxed together; nudged clear it needs a box of its own. Same cause as
   * the +1,204 kept triangles above, counted in colliders instead.
   *
   * -- And again: the habitat terrace moved off the avenue --------------
   * 369368 -> 369218 found, 199667 -> 199598 kept, 8785 -> 8776 chunks.
   * Ten planters moved 24 m off the carriageway centreline; the small fall
   * is those planters no longer sharing collision columns with the road
   * surface they were standing on. Colliders 26940 -> 26931, the same nine.
   */
  assert.equal(physics.colliders.length, 26931, 'the collider total changed');
});

test('every reported position is finite', async () => {
  const cat = await catalogue();
  /* Cheap, and it would have caught a real regression during Phase 0.
   *
   * `StationActors._hideActor` collapses a culled figure with an ALL-ZERO
   * matrix, whose w is zero. A `Box3` taken through one is NaN on every axis,
   * `Box3.isEmpty()` returns FALSE for a NaN box - so `_anchor`'s empty-guard
   * does not catch it - and `Math.round(NaN * 1000) / 1000` is NaN, which
   * `JSON.stringify` writes into the report as `null`.
   *
   * It cannot fire today: `InstancedMesh.boundingBox` is computed once and
   * three never invalidates it, and that one computation happens while every
   * instance matrix is still real. That is correct BY TIMING, not by
   * construction, so it is worth an assertion rather than a comment. */
  const bad = cat.filter((o) => !Number.isFinite(o.position.x) || !Number.isFinite(o.position.y) || !Number.isFinite(o.position.z));
  assert.deepEqual(bad.map((o) => o.name), [], 'non-finite anchors reported');
});

test('the name set and every anchor match the pin', async () => {
  const cat = await catalogue();
  const now = cat.map((o) => ({ name: o.name, position: o.position })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (UPDATE || !existsSync(FIXTURE)) {
    writeFileSync(FIXTURE, JSON.stringify(now, null, 1) + '\n');
    console.log(`  WROTE ${path.relative(process.cwd(), FIXTURE)} with ${now.length} entries`);
    if (!UPDATE) assert.fail('fixture did not exist and has been written - re-run to assert against it');
    return;
  }

  const was = JSON.parse(readFileSync(FIXTURE, 'utf8'));
  const wasMap = new Map(was.map((o) => [o.name, o.position]));
  const nowMap = new Map(now.map((o) => [o.name, o.position]));

  const retired = [...wasMap.keys()].filter((n) => !nowMap.has(n));
  const minted = [...nowMap.keys()].filter((n) => !wasMap.has(n));
  const moved = [...nowMap.keys()]
    .filter((n) => wasMap.has(n))
    .map((n) => {
      const a = nowMap.get(n), b = wasMap.get(n);
      return { name: n, dist: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), now: a, was: b };
    })
    .filter((m) => m.dist > POS_TOL)
    .sort((a, b) => b.dist - a.dist);

  for (const n of retired) console.log(`  RETIRED  ${n}   <- a saved document targeting this now resolves to nothing`);
  for (const n of minted) console.log(`  MINTED   ${n}`);
  for (const m of moved) console.log(`  ANCHOR   ${m.name}  moved ${m.dist.toFixed(3)} m   was (${m.was.x}, ${m.was.y}, ${m.was.z})  now (${m.now.x}, ${m.now.y}, ${m.now.z})`);

  assert.deepEqual(retired, [], `${retired.length} name(s) retired - every saved move or remove against them silently stops applying. If intended, re-take the fixture and list them in the commit.`);
  assert.deepEqual(minted, [], `${minted.length} new name(s). If intended, re-take the fixture and list them in the commit.`);
  assert.deepEqual(moved.map((m) => m.name), [], `${moved.length} anchor(s) moved - a saved move against these translates by a different vector than the admin dragged, and still reports ok:true.`);
});

test('the world bounds and the ground grid they project are pinned', async () => {
  const { world } = await buildStation();
  const b = world.bounds;

  /* C7. `planGrid` derives origin, step and extent from `world.bounds`, so a
   * bounds change RE-PROJECTS every stored cell rather than merely restating
   * its heights - and `out-of-bounds` is the only error-level conflict there
   * is, refusing the WHOLE document rather than the offending row. Bounds may
   * not move in a release that also re-authors placement; if they must, that
   * is a grid-migration release of its own. Four integers make that real. */
  assert.equal(WORLD_R, 744, 'WORLD_R moved - see C7, this re-projects every stored ground cell');
  assert.deepEqual(
    [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z],
    [-744, -6, -744, 744, DOME_APEX - 6, 744],
    'world.bounds moved'
  );

  const g = planGrid(b);
  console.log(`  grid: origin (${g.originX}, ${g.originZ}) step ${g.step} m, ${g.nx} x ${g.nz} = ${g.nx * g.nz} cells`);
  assert.deepEqual(
    { originX: g.originX, originZ: g.originZ, step: g.step, nx: g.nx, nz: g.nz },
    { originX: -744, originZ: -744, step: 6, nx: 249, nz: 249 },
    'the ground grid re-projected - every stored layout for this world now describes a different projection'
  );

  /* Pinned here as well as in the cross-tree contract test, because the four
   * integers above are only stable while these two are. */
  assert.equal(MAX_LAYERS, 4);
  assert.equal(LAYOUT_SCHEMA, 1);
});

test('the eighteen district-scale names are in the picker, and what that costs', async () => {
  const cat = await catalogue();
  const DISTRICTS = ['space', 'hull', 'deck', 'monument', 'gateways', 'promenade', 'commercial',
    'hangar', 'habitat', 'residential', 'control', 'cargo', 'station-enterables',
    'skyline', 'canopy', 'dressing', 'lights', 'actors'];

  /* Not a defect to fix here - it is the world's own group structure, and
   * `_catalogue` is breadth-first precisely so the large, obviously-editable
   * things come first. It is recorded because of what sits on the other side
   * of it: `_moveColliders` claims by centre-in-box with NO cap, NO userData
   * exclusion and NO warning, where `_collidersInside` has all three. So each
   * of these eighteen is a single drag that hauls a district's collision with
   * a green row. The move-side cap lands in Phase 2; this asserts the list has
   * not quietly grown before then. */
  const present = DISTRICTS.filter((n) => cat.some((o) => o.name === n));
  assert.deepEqual(present.sort(), [...DISTRICTS].sort(), 'a district-scale name left the catalogue');

  const topLevel = [...new Set(cat.map((o) => o.name))].filter((n) => !n.includes(':')).sort();
  console.log(`  ${present.length} district-scale names; ${topLevel.length} names with no colon at all`);
  assert.equal(topLevel.length, 36, 'the colon-free top-level name set changed - each of these is a one-click district-scale drag (C11)');
});

test('no named object can drag an uncapped district of collision on a move', async () => {
  const { world, physics } = await buildStation();
  const cat = await catalogue();
  const overlay = new MapOverlay({ physics });
  const box = new THREE.Box3();

  /* ── What this used to measure, and why it changed ────────────────────────
   * Before Phase 2 this counted how many names had more than 200 collider
   * CENTRES inside their box - 247 of 756, six of them over ten thousand, and
   * `space` holding all 26,352 in the world. That was the right measurement
   * then, because the move sweep took every one of them uncapped.
   *
   * It is the wrong measurement now. `_moveColliders` prefers ownership, and
   * ownership is not a count of what is nearby - it is the answer. So this
   * asks what the APPLIER would actually do with each name, through the real
   * method, rather than re-deriving a proxy for it.
   *
   * Three outcomes are allowed and one is not:
   *   OWNED    the object owns its colliders; exempt from the cap by design,
   *            because refusing a known answer would hide a mesh and leave the
   *            wall it stands for.
   *   CAPPED   nothing owns the name, the geometric guess exceeded
   *            MAX_MOVE_COLLIDERS, and the move is refused with `span` -
   *            reported to the admin, nothing moved, no invisible wall.
   *   SMALL    the guess is under the cap and is taken, as before.
   *   UNCAPPED a guess larger than the cap that is taken anyway. None may exist.
   */
  const ZERO = new THREE.Vector3(0, 0, 0);
  const ONE = new THREE.Vector3(1, 0, 0);
  let owned = 0, capped = 0, small = 0;
  const uncapped = [];

  for (const row of cat) {
    const node = world.group.getObjectByName(row.name);
    if (!node) continue;
    node.updateWorldMatrix(true, false);
    box.setFromObject(node);
    if (box.isEmpty()) continue;

    if (overlay._collidersOwnedBy(row.name)) { owned++; continue; }

    /* A zero delta returns 0 without sweeping, so the probe uses a unit one -
     * and `_moveColliders` MUTATES what it claims, so the refusal path (-1,
     * which moves nothing) is the only one safe to call here. Everything else
     * is counted by replicating the predicate, exactly as the baseline probe
     * does, so the measurement never moves the world it measures. */
    let n = 0;
    for (const c of physics.colliders) {
      if (!c || c.type === 'heightfield') continue;
      if (box.containsPoint(c.center)) n++;
      if (n > 200) break;
    }
    if (n > 200) {
      const refused = overlay._moveColliders(box, ONE, row.name);
      if (refused < 0) capped++;
      else uncapped.push(`${row.name} (${n}+ colliders, moved anyway)`);
    } else {
      small++;
    }
  }
  void ZERO;

  console.log(`  of ${cat.length} names: ${owned} own their colliders, ${capped} refused as too wide, ${small} under the cap`);
  assert.deepEqual(uncapped, [], 'a name would drag an uncapped district of collision on one drag');
  assert.ok(owned > 0, 'no object owns any collider - the ownerId path is not wired');
});

test('no name is a measurement: nothing in the address space carries a coordinate', async () => {
  const cat = await catalogue();

  /* ── What Phase 1 retired ─────────────────────────────────────────────────
   * `Tower.js` used to slug a ROUNDED WORLD POSITION into the name of every
   * tower interior and of every merged batch inside it - `tower-interior-201--479`
   * and `tower-int-201--479:panel`. That is not an identity, it is a
   * measurement: any change that shifts a tower renames it and everything under
   * it, and every saved document targeting the old string resolves to nothing
   * with reason `name`. It was 180 of 756 names, 24% of the whole address
   * space, and reconciling the two ROAD_W values would have moved most of them.
   *
   * They are now slugged from `spec.label`, which every caller already
   * authored - "Habitat Stack N1" is `habitat-stack-n1`, and it survives the
   * building being moved.
   *
   * The assertion is deliberately broader than the shape that was fixed: ANY
   * name carrying what looks like a signed coordinate pair fails, so the next
   * builder that reaches for `Math.round(x)` as an identity is caught on the
   * way in rather than after a document has been saved against it. */
  /* Deliberately wider than the shape that was fixed: a signed pair ANYWHERE
   * in the name, separated by `-` or `_`, so `${slug}-${round(x)}-${round(z)}-interior`
   * and the underscore forms are caught too. Not "no digits at all" - 78 of the
   * 744 names legitimately carry one (`habitat-stack-n1` among them). */
  const coordLike = cat.map((o) => o.name).filter((n) => /[-_]{1,2}\d+[-_]{1,2}\d+/.test(n)).sort();
  for (const n of coordLike) console.log(`    coordinate-baked: ${n}`);
  assert.deepEqual(coordLike, [], 'a name encodes a position - see slugLabel in StationKit.js');

  // And the labels really did produce the fourteen towers, rather than colliding.
  const towers = cat.map((o) => o.name).filter((n) => /^tower-interior-/.test(n)).sort();
  assert.equal(towers.length, 14, 'the fourteen tower interiors should each have their own name');
  assert.ok(towers.includes('tower-interior-habitat-stack-n1'), `expected a slugged hub tower, got ${towers.slice(0, 3).join(', ')}`);
});

test('nodes the editor must never offer are withheld from the picker', async () => {
  const cat = await catalogue();
  const names = cat.map((o) => o.name);

  /* Both kinds carry `userData[NOT_EDITABLE]`; see that constant in
   * MapOverlay.js for why each is not an object an admin can mean to move.
   *
   * `ramp-proxy` is one string shared by every proxy in the world, so the
   * picker showed a single row that resolved to whichever the traversal
   * reached first - and moving it separates the thing you walk on from the
   * ramp you can see. Fixed in StationKit via `markRampProxy`, so the yard and
   * every ship are covered by the same change rather than by three copies.
   *
   * `StationActors:*` is the world's whole fixed population in eleven
   * instanced buffers. They sat near the TOP of the picker because the walk is
   * breadth-first. */
  assert.deepEqual(names.filter((n) => n === 'ramp-proxy'), [], 'ramp proxies are still offered');
  assert.deepEqual(names.filter((n) => n.startsWith('StationActors')), [], 'actor part meshes are still offered');

  /* Withheld from the PICKER is not deleted from the WORLD: the applier
   * resolves by `getObjectByName` and never consults the catalogue, so a
   * document that already names one still applies. Production holds no such
   * entry - checked against every version of `map_overlays` - but the
   * distinction is the point, so it is asserted rather than assumed. */
  const { world } = await buildStation();
  assert.ok(world.group.getObjectByName('StationActors:head'), 'the mesh should still exist, just not be offered');
});

test('renaming a mesh renames its ablation identity, so those are pinned too', async () => {
  const { world } = await buildStation();

  /* S6. `_nameStrayMaterials` names every still-anonymous material
   * `mesh:${label(o)}`, where `label` walks UP to the first named ancestor -
   * and the art harness's `--ablate` switch matches on `material.name`,
   * reporting names it could not find only as a `missing` list.
   *
   * So a "names only" release silently retires ablation identities and
   * invalidates recorded art baselines, and the catalogue pin would show the
   * rename as an INTENDED delta while saying nothing about this. On a repo
   * whose own history records defective `--ablate` behaviour misdirecting four
   * world branches, that is worth four lines. */
  const materials = new Set();
  world.group.traverse((o) => {
    const m = o.material;
    if (!m) return;
    for (const mm of (Array.isArray(m) ? m : [m])) if (mm?.name) materials.add(mm.name);
  });
  const stray = [...materials].filter((n) => n.startsWith('mesh:')).sort();
  console.log(`  ablation identities from mesh names: ${stray.join(', ')}`);
  assert.deepEqual(stray, ['mesh:dressing', 'mesh:monument', 'mesh:ramp-proxy', 'mesh:space']);
});

test('the settle pass still resolves all seven of the groups it names', async () => {
  const { world } = await buildStation();

  /* S7, and the pin exists because Phase 0 reproduced the failure live.
   * `_settleDressing` resolves its districts by name and drops misses:
   *
   *     [...].map((n) => this.group.getObjectByName(n)).filter(Boolean)
   *
   * so a rename disables the lift-and-settle pass for a whole district with no
   * throw, no test failure and nothing in the catalogue pin to say so - the
   * pin would show the rename as intended. Renaming `dressing` in a scratch
   * branch moved `dressing:polish` FIFTY METRES, because its props were never
   * settled onto what they stand on.
   *
   * Read from the source rather than restated, so the list cannot drift. */
  const src = readFileSync(new URL('../../src/worlds/StationWorld.js', import.meta.url), 'utf8');
  const m = src.match(/_settleDressing\(breathe = noBreath\) \{\s*const groups = \[([^\]]*)\]/);
  assert.ok(m, 'could not read the settle group list out of _settleDressing - has it been restructured?');
  const wanted = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  assert.equal(wanted.length, 7, `expected seven settle groups, the source names ${wanted.length}`);

  const missing = wanted.filter((n) => !world.group.getObjectByName(n));
  assert.deepEqual(missing, [], `_settleDressing names groups the world does not have, so they are silently never settled: ${missing.join(', ')}`);
});
