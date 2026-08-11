/**
 * Automated placement and collision audit for the space station.
 *
 * ── What this is for ──────────────────────────────────────────────────────
 * The station is not placed by hand. Its props are scattered in bulk out of a
 * dozen loops, collided by two sweeps that run after the fact
 * (`_solidifyProps`, `_solidifyStructure`), and corrected by a third
 * (`_settleDressing`) that only ever lifts. Every one of those passes has a
 * documented blind spot, and the way those blind spots have been found so far
 * is somebody walking into one. This turns that into a measurement.
 *
 * Five checks, each answering one question about the finished world:
 *
 *   C1 GROUNDING   is every prop standing on something?
 *   C2 OVERLAP     is anything inside anything else?
 *   C3 COVERAGE    can you walk through anything you should not?
 *   C4 ESCALATOR   do the treads, the ramp collider and the floor slab meet?
 *   C5 RUN BREAKS  are the continuous rings cut where people walk through them?
 *
 * ── It is pure-read, and that is load-bearing ─────────────────────────────
 * Nothing here writes to the scene graph, to a matrix, to a material or to the
 * physics world. The audit runs against the same world the player is standing
 * in, and an instrument that perturbs its subject cannot be run twice or
 * trusted once. In particular `resolveCapsule` MUTATES the position it is
 * handed, so it is never called with a live one - see `_probeSupport`, which
 * uses raycasts throughout.
 *
 * ── Read this before believing a number ───────────────────────────────────
 * The known limits are written into the report itself, under `meta.blindSpots`
 * and each check's `skipped` map, rather than left for a reader to discover.
 * The two that matter most:
 *
 *  1. `GeoBatch` merges every authored piece that shares a material into ONE
 *     mesh named `<batch>:<materialKey>`, with no groups, no `userData` and no
 *     per-piece identity of any kind (StationKit.js:498). A merged batch's AABB
 *     is a whole district, so it cannot be audited as a prop and is counted out
 *     rather than reported as one enormous defect. The audited population is
 *     therefore the instanced scatter plus the standalone meshes small enough
 *     to be a single object.
 *  2. `physics.containsPoint` understands boxes and heightfields only - it has
 *     no branch for the triangle-soup colliders that carry all of the hub's
 *     structure (Physics.js:725). C3 says so out loud and corroborates with a
 *     triangle test before it calls anything a walk-through.
 */

import * as THREE from 'three';
import {
  AUDIT_VERSION, THRESHOLDS, DEG,
  aabbIntersection, aabbVolume, aabbSize, aabbCentre, footprintSamples,
  overlapSignificant, classifyGap, shouldBeSolid, SpatialHash,
  polarPoint, arcSeparation, crossingExists, roadMouthSamples, kerbLineSamples,
  triangleHeightAt, classifyRunBreak, escalatorDeltas, round,
} from './StationAuditMath.js';

/* ------------------------------------------------------------------ */
/* Which groups hold props, and what is never a prop                   */
/* ------------------------------------------------------------------ */

/**
 * Top-level groups inside `world.group` that carry free-standing props.
 *
 * `space`, `lights`, `actors`, `canopy`, `hull` and `dome` are deliberately
 * absent: they are sky, lighting, people, hung rigging and the pressure vessel,
 * none of which stands on the deck and all of which would swamp the report.
 */
const PROP_GROUPS = new Set([
  'dressing', 'monument', 'cargo', 'control', 'skyline', 'commercial',
  'hangar', 'habitat', 'residential', 'station-enterables', 'promenade',
  'deck', 'gateways',
]);

/** Every `zone:*` and `link:*` group counts too. */
function isPropGroup(name) {
  return PROP_GROUPS.has(name) || name.startsWith('zone:') || name.startsWith('link:');
}

/**
 * Material keys that mark geometry as something a player passes through.
 *
 * A superset of `StationKit.NON_SOLID_KEYS`, because that list exists to decide
 * what gets a COLLIDER and this one decides what is a PROP. Steam, holograms,
 * light pools, contact shadows and the crowd's own bodies all reach the scene
 * as ordinary meshes and none of them is an object that can be mis-placed.
 * Every `em*` emissive is excluded by prefix, as in `_collisionSoup`.
 */
const NON_PROP_KEYS = new Set([
  // StationKit.NON_SOLID_KEYS
  'rubber', 'wet', 'decals', 'decal', 'polish', 'signs',
  // StationKit.PROXY_KEYS - planting, collided as coarse boxes
  'foliage', 'foliagePale', 'foliageCard',
  // Not objects: light, shadow, glass, vapour, people.
  'holo', 'holoLine', 'steam', 'ceilHalo', 'contact', 'grime', 'route', 'pool',
  'crowd', 'skin', 'glassHull', 'glassWindow', 'shaft', 'shaftBig',
]);

function isNonPropKey(key) {
  return !key || NON_PROP_KEYS.has(key) || key.startsWith('em') || key.startsWith('gatePool');
}

/* ------------------------------------------------------------------ */
/* Scratch - allocated once, never handed to anything that mutates     */
/* ------------------------------------------------------------------ */

const _m = new THREE.Matrix4();
const _box = new THREE.Box3();
const _v = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

const toArr = (v) => [round(v.x), round(v.y), round(v.z)];
const boxOf = (b) => ({ min: toArr(b.min), max: toArr(b.max) });

/** A counted skip. Silent truncation is the one thing this instrument may not do. */
function skip(map, reason, n = 1) {
  map[reason] = (map[reason] ?? 0) + n;
}

/* ------------------------------------------------------------------ */
/* Population                                                          */
/* ------------------------------------------------------------------ */

/**
 * Every prop the audit will look at, with why everything else was left out.
 *
 * ── Instanced meshes ──────────────────────────────────────────────────────
 * One record per INSTANCE. This is the population that actually matters:
 * `_solidifyProps` and `_settleDressing` both operate per instance, so an
 * instance is the unit a defect is introduced at and the unit a fix lands on.
 *
 * ── Standalone meshes, and the merged-batch problem ───────────────────────
 * A standalone mesh in a prop group is nearly always a `GeoBatch` flush: forty
 * buildings' worth of geometry merged into one mesh so the district costs six
 * draw calls. Auditing that as "a prop" would produce one finding per district
 * whose AABB is the district, which is worse than useless. So a standalone mesh
 * is audited only when a single AABB can honestly stand for a single object -
 * bounded in extent and in triangle count - and counted out otherwise.
 */
function collectProps(world, opts) {
  const props = [];
  const skipped = {};
  const excludeMeshes = movingMeshes(world);
  const keyOf = materialKeyMap(world);

  const maxStandaloneSpan = opts.maxStandaloneSpan ?? 12;
  const maxStandaloneTris = opts.maxStandaloneTris ?? 2000;

  world.group.updateMatrixWorld(true);

  for (const group of world.group.children) {
    const gname = group.name || '';
    if (!isPropGroup(gname)) {
      let n = 0;
      group.traverse?.((o) => { if (o.isMesh) n++; });
      if (group.isMesh) n = 1;
      if (n) skip(skipped, `group-not-audited:${gname || group.type}`, n);
      continue;
    }

    group.traverse((o) => {
      if (!o.isMesh) return;
      if (!o.visible) { skip(skipped, 'invisible-mesh (includes _ramp proxies)', 1); return; }
      if (excludeMeshes.has(o)) { skip(skipped, 'moving-machinery (escalator/travelator treads)', 1); return; }

      const mat = Array.isArray(o.material) ? o.material[0] : o.material;
      const key = keyOf.get(mat) ?? (o.name || '').split(':')[1] ?? '';
      if (isNonPropKey(key)) {
        skip(skipped, `non-solid-material-key:${key || '(none)'}`, o.isInstancedMesh ? o.count : 1);
        return;
      }
      if (mat && (mat.transparent || mat.depthWrite === false || mat.blending === THREE.AdditiveBlending)) {
        skip(skipped, 'transparent/additive material', o.isInstancedMesh ? o.count : 1);
        return;
      }

      const geo = o.geometry;
      if (!geo?.getAttribute('position')) { skip(skipped, 'mesh without positions', 1); return; }
      if (!geo.boundingBox) geo.computeBoundingBox();
      const idx = geo.getIndex();
      const tris = (idx ? idx.count : geo.getAttribute('position').count) / 3;

      if (o.isInstancedMesh) {
        for (let i = 0; i < o.count; i++) {
          o.getMatrixAt(i, _m);
          _m.premultiply(o.matrixWorld);
          _box.copy(geo.boundingBox).applyMatrix4(_m);
          pushProp(props, skipped, gname, key, o.name, i, _box, opts);
        }
      } else {
        _box.copy(geo.boundingBox).applyMatrix4(o.matrixWorld);
        const span = Math.max(_box.max.x - _box.min.x, _box.max.z - _box.min.z);
        if (span > maxStandaloneSpan || tris > maxStandaloneTris) {
          /* A merged GeoBatch. See the note on this function - there is no
           * per-piece identity left to attribute a finding to. */
          skip(skipped, 'merged-batch-mesh (no per-prop identity survives GeoBatch)', 1);
          return;
        }
        pushProp(props, skipped, gname, key, o.name, -1, _box, opts);
      }
    });
  }
  return { props, skipped };
}

function pushProp(props, skipped, group, materialKey, meshName, instanceIndex, b, opts) {
  const airborne = opts.airborneY ?? THRESHOLDS.airborneY;
  if (b.min.y > airborne) {
    skip(skipped, `airborne (underside above ${airborne} m: ceiling fixtures, banners, rigging)`, 1);
    return;
  }
  const box = boxOf(b);
  const size = aabbSize(box);
  if (size[0] <= 0 || size[1] <= 0 || size[2] <= 0) {
    skip(skipped, 'degenerate AABB', 1);
    return;
  }
  props.push({
    group, materialKey, meshName: meshName || '(unnamed)', instanceIndex,
    box, size, centre: aabbCentre(box), volume: round(aabbVolume(box)),
  });
}

/** Material -> key, exactly as `_collisionSoup` derives it. */
function materialKeyMap(world) {
  const map = new Map();
  for (const [k, m] of Object.entries(world.mat ?? {})) if (m?.isMaterial) map.set(m, k);
  return map;
}

/**
 * Meshes whose instances are driven every frame.
 *
 * The escalator treads and the travelator belt slide along their runs and wrap,
 * so where an instance is depends on how long the page has been open. Auditing
 * them as props would report a different defect on every run. They are checked
 * properly, as machinery, by C4.
 */
function movingMeshes(world) {
  const set = new Set();
  for (const bank of world._escalators ?? []) if (bank.mesh) set.add(bank.mesh);
  for (const t of world._travelators ?? []) {
    if (t?.mesh) set.add(t.mesh);
    else if (t?.isMesh) set.add(t);
  }
  return set;
}

/* ------------------------------------------------------------------ */
/* Probes                                                              */
/* ------------------------------------------------------------------ */

/**
 * The highest solid surface under (x, z), starting from `startY`.
 *
 * A raycast, not `resolveCapsule`: the capsule solver mutates the position it
 * is given, and there is no version of "borrow the player's feet for a moment"
 * that is safe to run against a live world.
 *
 * One property of `Physics._raycastCollider` makes this work at all: a ray that
 * STARTS inside a box collider is rejected (`tmin <= 0` returns null), so a
 * probe launched from just inside a prop cannot be stopped by that prop's own
 * box. Instanced props - which is the whole audited population bar a few
 * hundred - are collided as boxes by `_solidifyProps` and are excluded from the
 * triangle soup by `_collisionSoup`, so no self-hit is possible for them.
 */
function probeSupport(physics, x, z, startY, maxDrop = 400) {
  const hit = physics.raycast(_origin.set(x, startY, z), _down, maxDrop);
  return hit ? hit.point.y : null;
}

const _up = new THREE.Vector3(0, 1, 0);

/**
 * Is this prop attached to something rather than standing on the floor?
 *
 * ── The problem this solves ───────────────────────────────────────────────
 * "Nothing directly underneath" and "wrongly placed" are not the same claim,
 * and conflating them makes C1 useless on this world. A downlight over the
 * galley's servery is 4.7 m above the deck with four and a half metres of air
 * beneath it, and it is exactly where it belongs. The brief's 12 m airborne cut
 * is the right instinct and the wrong number here: the outer zones' arcades are
 * six metres tall, so every fixture in all four of them sits under it. Measured
 * on the finished station, an unqualified C1 called 8,128 props floating, and
 * the great majority were light fittings, wall cladding, signage brackets and
 * the upper halves of multi-part furniture.
 *
 * So a prop that finds no support is asked a second question: is it TOUCHING
 * anything? Something within a hand's breadth overhead, or immediately beside
 * it, is mounted - hung, bracketed, bolted to a wall - and a mount is a
 * placement decision the audit has no business second-guessing. A prop with air
 * on every side and floor far below is the real finding, and that is the one
 * reported as `FLOAT`.
 *
 * Both halves are recorded on the finding either way, so a reader who disagrees
 * with the distinction can re-derive the unqualified count from the report.
 */
function probeAttachment(physics, box, meshHash, meshIndex) {
  const reach = 0.35;
  const [minx, miny, minz] = box.min;
  const [maxx, maxy, maxz] = box.max;
  const midY = (miny + maxy) / 2;

  const overhead = physics.raycast(_origin.set((minx + maxx) / 2, maxy + 0.01, (minz + maxz) / 2), _up, reach);
  if (overhead) return { attached: true, how: 'overhead' };

  const pad = 0.12;
  const sides = [
    [minx - pad, midY, (minz + maxz) / 2], [maxx + pad, midY, (minz + maxz) / 2],
    [(minx + maxx) / 2, midY, minz - pad], [(minx + maxx) / 2, midY, maxz + pad],
  ];
  for (const s of sides) if (physics.containsPoint(_v.set(s[0], s[1], s[2]))) return { attached: true, how: 'lateral-box' };

  /* The lateral test again, against the triangle-soup colliders that
   * `containsPoint` cannot see (Physics.js:725). Without this half, every prop
   * bracketed to a hub wall - which is collided from its own triangles, not by
   * a box - would still be called free-standing. */
  const shell = {
    min: [minx - pad, miny, minz - pad],
    max: [maxx + pad, maxy, maxz + pad],
  };
  if (trianglesBetween(box, shell, meshHash, meshIndex) > 0) return { attached: true, how: 'lateral-mesh' };
  return { attached: false, how: null };
}

/** Collision-triangle vertices inside `outer` but outside `inner`. */
function trianglesBetween(inner, outer, hash, index) {
  let n = 0;
  for (const id of hash.candidates(outer)) {
    const pos = index[id].positions;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < outer.min[0] || x > outer.max[0] || y < outer.min[1] || y > outer.max[1] || z < outer.min[2] || z > outer.max[2]) continue;
      if (x > inner.min[0] && x < inner.max[0] && y > inner.min[1] && y < inner.max[1] && z > inner.min[2] && z < inner.max[2]) continue;
      n++;
      if (n > 2) return n;      // three vertices is a triangle's worth of contact
    }
  }
  return n;
}

/** The triangle-soup colliders, indexed by their bounds. Built once, shared. */
function meshColliderIndex(physics) {
  const index = physics.colliders.filter((c) => c.type === 'mesh' && c.solid !== false);
  const hash = new SpatialHash(16);
  for (const c of index) {
    hash.insert({
      min: [c.bounds.min.x, c.bounds.min.y, c.bounds.min.z],
      max: [c.bounds.max.x, c.bounds.max.y, c.bounds.max.z],
    });
  }
  return { hash, index };
}

/* ------------------------------------------------------------------ */
/* C1 GROUNDING                                                        */
/* ------------------------------------------------------------------ */

/**
 * Is every prop standing on something?
 *
 * The probe starts half a metre above the prop's underside and looks down, so a
 * prop sunk up to 0.5 m into its support still sees the support. Deeper than
 * that and the ray starts below the surface; those are reported as
 * `NO_SUPPORT` with the fallback `physics.groundHeight` figure beside them
 * rather than silently rounded to zero.
 *
 * WHY FIVE PROBES AND NOT ONE, AND WHY THE NEAREST RATHER THAN THE HIGHEST.
 * A single column through the centre is wrong for anything supported at its
 * edges - a bench slat over its legs, a gantry over its posts, a lid on a
 * crate. The centre column finds the floor far below and the prop reads as
 * floating by exactly the height of its own legs, which over the station's
 * multi-part instanced furniture is thousands of findings about nothing.
 *
 * So five columns are cast across the footprint. Taking the HIGHEST of them is
 * the obvious move and is also wrong: in a dense scatter a corner column lands
 * on the neighbour rather than on the support, and the prop is then reported as
 * SUNK into something it is merely standing next to. The support is therefore
 * the surface NEAREST the prop's own underside - the most favourable reading of
 * "is this thing resting on anything".
 *
 * That choice is conservative on purpose, and it is the honest description of
 * what a C1 finding means: not "this prop's centre is over a hole" but "there
 * is nothing under ANY part of this prop's footprint at the height it sits at".
 */
function checkGrounding(props, physics, mesh, opts) {
  const skipped = {};
  const findings = [];
  const t = opts.thresholds;
  let examined = 0;
  let attached = 0;

  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    const [cx, , cz] = p.centre;
    const startY = p.box.min[1] + 0.5;
    examined++;

    let surfaceY = null;
    let probes = 0;
    for (const s of footprintSamples(p.box)) {
      const y = probeSupport(physics, s[0], s[2], startY);
      probes++;
      if (y === null) continue;
      if (surfaceY === null || Math.abs(p.box.min[1] - y) < Math.abs(p.box.min[1] - surfaceY)) surfaceY = y;
    }

    let fallbackY = null;
    if (surfaceY === null) {
      // Documented fallback: from high above, so it answers for anything the
      // low probe started underneath. It can be the prop's own top when the
      // prop is collided, which is why it is reported separately and never
      // used as the gap.
      fallbackY = physics.groundHeight(cx, cz, 400, 900);
    }

    const gap = surfaceY === null ? null : round(p.box.min[1] - surfaceY);
    const raw = classifyGap(gap, t);
    if (raw === 'OK') continue;

    /* Only a prop with nothing under it is asked whether it is mounted. A SUNK
     * prop is intersecting its support, and no amount of bracketing makes that
     * right. */
    let mount = { attached: false, how: null };
    if (raw === 'FLOAT' || raw === 'NO_SUPPORT') {
      mount = probeAttachment(physics, p.box, mesh.hash, mesh.index);
      if (mount.attached) attached++;
    }
    const verdict = mount.attached ? `${raw}_ATTACHED` : raw;

    findings.push({
      group: p.group, materialKey: p.materialKey, meshName: p.meshName,
      instanceIndex: p.instanceIndex,
      position: p.centre, size: p.size,
      gap, surfaceY: surfaceY === null ? null : round(surfaceY),
      groundHeightFallback: fallbackY === null ? null : round(fallbackY),
      probes,
      attachedTo: mount.how,
      verdict,
    });
  }

  findings.sort((a, b) => Math.abs(b.gap ?? 1e9) - Math.abs(a.gap ?? 1e9));
  return {
    name: 'C1_GROUNDING', examined, skipped, findings,
    attachedToSomething: attached,
    note: '*_ATTACHED means nothing is under the prop but something is directly overhead or beside it - a mounted fixture, not a placement defect',
  };
}

/* ------------------------------------------------------------------ */
/* C2 OVERLAP                                                          */
/* ------------------------------------------------------------------ */

/**
 * Is anything inside anything else?
 *
 * Pairwise AABB intersection through a uniform 4 m hash - 32,000 props is half
 * a billion pairs swept naively, which is minutes in a browser and would make
 * this check something nobody runs.
 *
 * The threshold is deliberately relative to the SMALLER prop: a bollard a third
 * buried in a planter is a defect, and the same cubic metre shared between two
 * warehouse blocks is a party wall.
 */
function checkOverlap(props, opts) {
  const skipped = {};
  const findings = [];
  const t = opts.thresholds;
  const hash = new SpatialHash(t.overlapCell);
  for (const p of props) hash.insert(p.box);

  let tested = 0;
  let reported = 0;
  hash.forEachPair((i, j) => {
    tested++;
    const a = props[i], b = props[j];
    const { volume, box } = aabbIntersection(a.box, b.box);
    if (!overlapSignificant(volume, a.volume, b.volume, t)) return;
    reported++;
    if (findings.length >= opts.maxFindings) return;
    findings.push({
      a: { group: a.group, materialKey: a.materialKey, meshName: a.meshName, instanceIndex: a.instanceIndex, position: a.centre, size: a.size, volume: a.volume },
      b: { group: b.group, materialKey: b.materialKey, meshName: b.meshName, instanceIndex: b.instanceIndex, position: b.centre, size: b.size, volume: b.volume },
      intersectionVolume: round(volume),
      fractionOfSmaller: round(volume / Math.max(1e-9, Math.min(a.volume, b.volume))),
      box,
      verdict: 'OVERLAP',
    });
  });

  if (reported > findings.length) {
    skip(skipped, `findings beyond maxFindings=${opts.maxFindings} (counted, not listed)`, reported - findings.length);
  }
  findings.sort((x, y) => y.intersectionVolume - x.intersectionVolume);
  return { name: 'C2_OVERLAP', examined: props.length, skipped, findings, findingCount: reported, pairsTested: tested };
}

/* ------------------------------------------------------------------ */
/* C3 COLLIDER COVERAGE                                                */
/* ------------------------------------------------------------------ */

/**
 * Can you walk through anything you should not?
 *
 * `physics.containsPoint` is the primary test, as the brief specifies. It has a
 * hole in it that has to be stated: it branches on `box` and `heightfield` and
 * on nothing else (Physics.js:725), so every triangle-soup chunk that
 * `_solidifyStructure` built - which is all of the hub's structural collision,
 * 8,192 chunks of it - answers "no" to every point inside it.
 *
 * That would report a walk-through for anything collided by triangles rather
 * than by a box. So a second, independent test runs before anything is called a
 * defect: are there any collision triangles inside the prop's own volume? Only
 * a prop that fails BOTH is reported as `NO_COLLIDER`. A prop that fails only
 * the first is reported as `MESH_ONLY_COVERAGE`, which is not a defect - it is
 * this instrument telling you which half of the answer it could not get.
 */
function checkCoverage(props, physics, mesh, opts) {
  const skipped = {};
  const findings = [];
  const t = opts.thresholds;
  let examined = 0;
  const meshHash = mesh.hash;
  const meshIndex = mesh.index;

  /* Partial coverage is counted in the same pass. A prop half inside its own
   * collider is not a walk-through, but it is the shape of one - a box placed
   * at the wrong height - and a report that only ever says "covered / not
   * covered" cannot show it. */
  let partial = 0;
  for (const p of props) {
    if (!shouldBeSolid(p.box, t)) {
      skip(skipped, 'too thin or too low to be expected to collide (trim, kerbs, decals)', 1);
      continue;
    }
    examined++;
    const samples = footprintSamples(p.box, t.coverageSampleFraction);
    let contained = 0;
    for (const s of samples) if (physics.containsPoint(_v.set(s[0], s[1], s[2]))) contained++;
    if (contained > 0) {
      if (contained < samples.length) partial++;
      continue;
    }

    const meshTris = trianglesInside(p.box, meshHash, meshIndex);
    findings.push({
      group: p.group, materialKey: p.materialKey, meshName: p.meshName,
      instanceIndex: p.instanceIndex,
      position: p.centre, size: p.size,
      containedFraction: 0,
      samples: samples.length,
      collisionTrianglesInside: meshTris,
      verdict: meshTris > 0 ? 'MESH_ONLY_COVERAGE' : 'NO_COLLIDER',
    });
  }

  findings.sort((a, b) =>
    (b.size[0] * b.size[1] * b.size[2]) - (a.size[0] * a.size[1] * a.size[2]));
  return {
    name: 'C3_COVERAGE', examined, skipped, findings,
    partiallyCovered: partial,
    note: 'physics.containsPoint has no triangle-soup branch; NO_COLLIDER is only reported when a direct triangle test agrees',
  };
}

/** How many collision triangles have a vertex strictly inside `box`. */
function trianglesInside(box, hash, index) {
  const eps = 0.05;
  const shrunk = {
    min: [box.min[0] + eps, box.min[1] + eps, box.min[2] + eps],
    max: [box.max[0] - eps, box.max[1] - eps, box.max[2] - eps],
  };
  if (shrunk.min[0] >= shrunk.max[0] || shrunk.min[1] >= shrunk.max[1] || shrunk.min[2] >= shrunk.max[2]) return 0;
  let n = 0;
  for (const id of hash.candidates(box)) {
    const pos = index[id].positions;
    for (let i = 0; i < pos.length; i += 3) {
      if (pos[i] >= shrunk.min[0] && pos[i] <= shrunk.max[0] &&
          pos[i + 1] >= shrunk.min[1] && pos[i + 1] <= shrunk.max[1] &&
          pos[i + 2] >= shrunk.min[2] && pos[i + 2] <= shrunk.max[2]) n++;
    }
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* C4 ESCALATOR ALIGNMENT                                              */
/* ------------------------------------------------------------------ */

/**
 * Do the treads, the ramp collider and the floor slab meet at both ends?
 *
 * Three surfaces have to agree at each end of every flight and they are
 * authored in three different places: the treads are instances placed by
 * Tower.js, the thing a player actually stands on is an invisible `_ramp` proxy
 * box, and the floor is `floorY(f)`. Nothing checks them against each other.
 *
 * THE TREADS MOVE. They slide along the slope and wrap, so "the tread at the
 * bottom" is a different instance and a different height every time the page is
 * looked at. Reading one instance would measure the animation's phase and call
 * it a misalignment. So the tread LINE is fitted instead: every instance is
 * projected onto the run and extrapolated back to the foot, and the median is
 * taken. That is phase-independent and is what the geometry actually promises.
 */
function checkEscalators(world, physics, opts) {
  const skipped = {};
  const findings = [];
  const t = opts.thresholds;
  const measurements = [];
  let examined = 0;

  const banks = world._escalators ?? [];
  if (!banks.length) skip(skipped, 'no escalator banks published by the world', 1);

  const PLINTH = 0.9, FLOOR_H = 3.9;
  const floorYOf = (f) => PLINTH + f * FLOOR_H;
  const ramps = rampProxies(world);

  for (let bi = 0; bi < banks.length; bi++) {
    const bank = banks[bi];
    const mesh = bank.mesh;
    if (!mesh?.isInstancedMesh) { skip(skipped, 'escalator bank without an instanced tread mesh', 1); continue; }
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    const halfTread = (mesh.geometry.boundingBox.max.y - mesh.geometry.boundingBox.min.y) / 2;

    for (let ri = 0; ri < (bank.runs ?? []).length; ri++) {
      const run = bank.runs[ri];
      const a = new THREE.Vector3().fromArray(run.world.a.toArray ? run.world.a.toArray() : run.world.a);
      const b = new THREE.Vector3().fromArray(run.world.b.toArray ? run.world.b.toArray() : run.world.b);
      examined++;

      /* --- the tread line, fitted rather than sampled -----------------
       *
       * Extrapolated along the HORIZONTAL projection of the run, not along the
       * slope. Projecting onto the 3D axis is self-consistent only for points
       * exactly on the line: lift a tread by 0.10 m and the 3D projection moves
       * too, so the fit absorbs a quarter of the displacement and reports 0.075
       * for a 0.100 m error. That is precisely the failure mode this check
       * exists to catch, so it cannot be allowed to hide in the estimator - it
       * was found by the self-test's injected 0.10 m nudge and is why that case
       * is in the gate. Against the horizontal run, a purely vertical move
       * shows up at exactly its own size. */
      const axis = new THREE.Vector3().subVectors(b, a);
      const len = axis.length();
      const dirU = axis.clone().normalize();
      const runH = Math.hypot(b.x - a.x, b.z - a.z);
      const hx = runH > 0 ? (b.x - a.x) / runH : 0;
      const hz = runH > 0 ? (b.z - a.z) / runH : 0;
      const slopeH = runH > 0 ? (b.y - a.y) / runH : 0;
      const atFoot = [];
      for (let i = run.first; i < run.first + run.count && i < mesh.count; i++) {
        mesh.getMatrixAt(i, _m);
        _m.premultiply(mesh.matrixWorld);
        _v.setFromMatrixPosition(_m);
        const s = (_v.x - a.x) * hx + (_v.z - a.z) * hz;
        // Vertical distance from the tread's own centre to its top face. The
        // tread is pitched, so half its thickness measured vertically is
        // halfTread / cos(pitch).
        const top = _v.y + halfTread / Math.cos(Math.abs(run.pitch ?? 0));
        atFoot.push(top - s * slopeH);
      }
      if (!atFoot.length) { skip(skipped, 'escalator run with no tread instances', 1); continue; }
      atFoot.sort((x, y) => x - y);
      const treadBottom = atFoot[Math.floor(atFoot.length / 2)];
      const treadTop = treadBottom + (b.y - a.y);

      /* --- the ramp collider's walking surface ------------------------ */
      const ramp = nearestRamp(ramps, a, b);
      const rampBottom = ramp ? rampSurfaceAt(ramp, a.x, a.z) : null;
      const rampTop = ramp ? rampSurfaceAt(ramp, b.x, b.z) : null;

      /* --- the floor slabs it lands on -------------------------------- */
      const f = Math.round((a.y - PLINTH) / FLOOR_H);
      const floorBottom = floorYOf(f);
      const floorTop = floorYOf(f + 1);

      const ends = {
        bottom: escalatorDeltas({ treadY: treadBottom, rampY: rampBottom ?? NaN, floorY: floorBottom }),
        top: escalatorDeltas({ treadY: treadTop, rampY: rampTop ?? NaN, floorY: floorTop }),
      };

      /* --- bottom overrun: is there anything under the foot? ---------- */
      const footBack = new THREE.Vector3().copy(a).addScaledVector(dirU, -0.4);
      const underFoot = probeSupport(physics, footBack.x, footBack.z, a.y + 1.2, 60);
      const overrunDrop = underFoot === null ? null : round(a.y - underFoot);

      const m = {
        bank: bi, run: ri, floor: f,
        foot: [round(a.x), round(a.y), round(a.z)],
        head: [round(b.x), round(b.y), round(b.z)],
        length: round(len),
        bottom: {
          treadTopY: round(treadBottom), rampSurfaceY: round(rampBottom), floorSlabY: round(floorBottom),
          deltas: ends.bottom,
        },
        top: {
          treadTopY: round(treadTop), rampSurfaceY: round(rampTop), floorSlabY: round(floorTop),
          deltas: ends.top,
        },
        overrun: {
          supported: underFoot !== null,
          surfaceY: underFoot === null ? null : round(underFoot),
          drop: overrunDrop,
        },
        rampFound: !!ramp,
      };
      measurements.push(m);

      const worst = Math.max(
        Number.isFinite(ends.bottom.worst) ? ends.bottom.worst : 0,
        Number.isFinite(ends.top.worst) ? ends.top.worst : 0,
      );
      const verdicts = [];
      if (!ramp) verdicts.push('NO_RAMP_COLLIDER');
      if (worst > t.escalatorTolerance) verdicts.push('MISALIGNED');
      if (underFoot === null) verdicts.push('FOOT_UNSUPPORTED');
      else if (overrunDrop > t.stepHeight) verdicts.push('FOOT_OVERRUN');
      if (!verdicts.length) continue;
      findings.push({ ...m, worstDelta: round(worst), verdict: verdicts.join('+') });
    }
  }

  findings.sort((x, y) => (y.worstDelta ?? 0) - (x.worstDelta ?? 0));
  return { name: 'C4_ESCALATOR', examined, skipped, findings, measurements };
}

/**
 * The invisible `_ramp` proxies, which are what a player actually stands on.
 *
 * They are added straight to `world.group` as unnamed, invisible box meshes
 * (StationWorld.js `_ramp`) - no marker, no `userData`, nothing to look them up
 * by. Invisible + geometry that is a box + a tilted world matrix is the whole
 * signature there is.
 */
function rampProxies(world) {
  const out = [];
  for (const child of world.group.children) {
    if (!child.isMesh || child.visible || child.isInstancedMesh) continue;
    if (!child.geometry?.boundingBox) child.geometry?.computeBoundingBox?.();
    if (!child.geometry?.boundingBox) continue;
    out.push(child);
  }
  return out;
}

/** The proxy whose centre is nearest the middle of a flight. */
function nearestRamp(ramps, a, b) {
  const mid = new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5);
  let best = null, bestD = 2.5;      // a flight's ramp is centred within ~0.5 m
  for (const r of ramps) {
    const d = _v.setFromMatrixPosition(r.matrixWorld).distanceTo(mid);
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/**
 * Height of a ramp proxy's TOP face above (x, z).
 *
 * The proxy is a 0.5 m slab tilted about its own local X, so its top face is a
 * plane; the walking surface is that plane, not the proxy's centre. Solved from
 * the plane through the top-face centre with the proxy's local +Y as its
 * normal, which is exact for any yaw and pitch.
 */
function rampSurfaceAt(ramp, x, z) {
  const half = (ramp.geometry.boundingBox.max.y - ramp.geometry.boundingBox.min.y) / 2;
  const normal = new THREE.Vector3(0, 1, 0).transformDirection(ramp.matrixWorld).normalize();
  const centre = new THREE.Vector3().setFromMatrixPosition(ramp.matrixWorld);
  const top = centre.clone().addScaledVector(normal, half);
  if (Math.abs(normal.y) < 1e-6) return null;
  // n . (p - top) = 0, solved for p.y at the given x, z.
  return top.y - (normal.x * (x - top.x) + normal.z * (z - top.z)) / normal.y;
}

/* ------------------------------------------------------------------ */
/* C5 CONTINUOUS-RUN BREAKS                                            */
/* ------------------------------------------------------------------ */

const PLAZA_R = 40, ROAD_W = 18, DECK_R = 200, LOOP_R = 72, LOOP_Y = 10;
const AVENUES = [0, 60, 120, 180, 240, 300];
const LOOP_STAIRS = [30, 150, 210, 330];

/**
 * Are the continuous rings cut where people walk through them?
 *
 * Each run is sampled at the points where something traversable crosses it, and
 * the answer is the height of whatever solid thing is standing there, measured
 * from the local walking surface. Both the DRAWN geometry and the COLLIDERS are
 * read, because the two can disagree and either disagreement is worth knowing:
 * a kerb drawn across a road mouth with no collider is a visual defect, and a
 * collider with no geometry is an invisible wall.
 *
 * WHAT IS DELIBERATELY EXCLUDED. The hull transom rings at y = 12, 24, 36 and
 * 47.2 are continuous all the way round, and that is correct: they sit above
 * the 11.2 m lintel, nobody can reach them, and cutting them would put a gap in
 * the pressure hull's structure for no reason. They are named in `skipped`
 * rather than left out quietly.
 */
function checkRunBreaks(world, physics, opts) {
  const skipped = {};
  const findings = [];
  const t = opts.thresholds;
  skip(skipped, 'hull transom rings at y=12/24/36/47.2 (above the 11.2 m lintel, intentionally continuous)', 4);

  /* Collect every column to be sampled first, so the drawn geometry can be
   * read in ONE traversal of the world instead of one per sample. */
  const columns = [];
  const push = (run, crossing, x, z, floorY, band, extra = {}) =>
    columns.push({ run, crossing, x, z, floorY, band, ...extra });

  // 1. Plaza kerb ring, where each of the six avenues leaves the plaza.
  for (const deg of AVENUES) {
    for (const s of roadMouthSamples(deg, PLAZA_R + 0.3, ROAD_W, 5)) {
      push('plaza-kerb-ring', `avenue-${deg}`, s.x, s.z, 0, 2.5, { off: round(s.off) });
    }
  }

  // 2. Avenue kerbs, where the walkway loop and its stair flights cross them.
  const kerbOff = ROAD_W / 2 + 0.45;
  for (const deg of AVENUES) {
    for (const side of [-1, 1]) {
      // The loop passes overhead at r = LOOP_R; its columns are the thing that
      // could land on a kerb. Sample the kerb line right under the loop.
      for (const s of kerbLineSamples(deg, LOOP_R - 3, LOOP_R + 3, kerbOff, side, 5)) {
        push('avenue-kerb', `walkway-loop@${deg}/${side > 0 ? 'L' : 'R'}`, s.x, s.z, 0, 2.5, { r: round(s.r) });
      }
      // The four stair flights. Whether they cross at all is geometry, not
      // opinion - see `crossingExists`.
      for (const sdeg of LOOP_STAIRS) {
        const reaches = crossingExists(sdeg, deg, LOOP_R, 2.5, kerbOff);
        if (!reaches) continue;
        for (const s of kerbLineSamples(deg, LOOP_R, 88, kerbOff, side, 5)) {
          push('avenue-kerb', `loop-stair-${sdeg}@${deg}/${side > 0 ? 'L' : 'R'}`, s.x, s.z, 0, 2.5, { r: round(s.r) });
        }
      }
    }
  }

  // 3. Walkway-loop railing, at each of the four stair arrival points. The
  //    flights climb from r = 88 in to r = LOOP_R, so they arrive across the
  //    OUTER railing at LOOP_R + (width/2 - 0.15).
  const railOuter = LOOP_R + (6 / 2 - 0.15);
  const railInner = LOOP_R - (6 / 2 - 0.15);
  for (const sdeg of LOOP_STAIRS) {
    for (const [name, rr] of [['outer', railOuter], ['inner', railInner]]) {
      for (let i = -2; i <= 2; i++) {
        const off = i * 0.9;                       // across the 4.6 m flight
        const [x, z] = polarPoint(sdeg, rr, off);
        push('walkway-loop-railing', `stair-${sdeg}-${name}`, x, z, LOOP_Y, 2.2, { off: round(off) });
      }
    }
  }

  /* --- read the drawn geometry, once ------------------------------- */
  const geomTops = geometryTopAtColumns(world, columns);

  /* --- and the colliders, per column ------------------------------- */
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    const top = probeSupport(physics, c.x, c.z, c.floorY + c.band, c.band + 0.3);
    c.colliderTopY = top === null ? null : round(top);
    c.geometryTopY = geomTops[i] === null ? null : round(geomTops[i]);
    const heights = [
      c.colliderTopY === null ? null : c.colliderTopY - c.floorY,
      c.geometryTopY === null ? null : c.geometryTopY - c.floorY,
    ].filter((h) => h !== null);
    c.obstructionHeight = heights.length ? round(Math.max(...heights)) : null;
  }

  /* --- one row per (run, crossing), across the whole opening -------
   *
   * The worst column alone is not the answer, and using it produced the first
   * wrong reading this check gave: a 2.2 m bollard standing at the KERB of a
   * road mouth made the mouth "blocked" while eighteen metres of carriageway
   * beside it was clear. What decides whether people can get through is how
   * much of the opening is passable, so every column is kept and the verdict is
   * about the set: BLOCKED when nothing gets through, PARTIALLY_BLOCKED when
   * something is standing in an opening that is otherwise walkable. */
  const byCrossing = new Map();
  for (const c of columns) {
    const key = `${c.run}|${c.crossing}`;
    let list = byCrossing.get(key);
    if (!list) byCrossing.set(key, (list = []));
    list.push(c);
  }

  const rows = [];
  for (const list of byCrossing.values()) {
    const worst = list.reduce((m, c) => Math.max(m, c.obstructionHeight ?? 0), 0);
    const passable = list.filter((c) => (c.obstructionHeight ?? 0) <= t.stepHeight);
    const first = list[0];
    let verdict;
    if (passable.length === 0) verdict = 'BLOCKED';
    else if (worst > t.stepHeight) verdict = 'PARTIALLY_BLOCKED';
    else verdict = classifyRunBreak(worst, t).verdict;

    const row = {
      run: first.run, crossing: first.crossing,
      blocked: verdict === 'BLOCKED' || verdict === 'PARTIALLY_BLOCKED',
      obstructionHeight: round(worst),
      columnsSampled: list.length,
      columnsPassable: passable.length,
      floorY: first.floorY,
      verdict,
      stepHeight: t.stepHeight,
      columns: list.map((c) => ({
        at: [round(c.x), round(c.z)],
        off: c.off, r: c.r,
        obstructionHeight: c.obstructionHeight,
        colliderTopY: c.colliderTopY, geometryTopY: c.geometryTopY,
      })),
    };
    rows.push(row);
    if (verdict === 'BLOCKED' || verdict === 'PARTIALLY_BLOCKED') findings.push(row);
  }
  rows.sort((a, b) => (b.obstructionHeight ?? 0) - (a.obstructionHeight ?? 0));

  // Crossings that geometry says cannot happen, said out loud.
  for (const deg of AVENUES) {
    for (const sdeg of LOOP_STAIRS) {
      if (crossingExists(sdeg, deg, LOOP_R, 2.5, kerbOff)) continue;
      skip(skipped, `loop stair ${sdeg} never reaches avenue ${deg} kerb (arc separation ${Math.round(arcSeparation(sdeg, deg, LOOP_R))} m)`, 1);
    }
  }

  findings.sort((a, b) => (b.obstructionHeight ?? 0) - (a.obstructionHeight ?? 0));
  return { name: 'C5_RUN_BREAKS', examined: rows.length, skipped, findings, crossings: rows, columnsSampled: columns.length };
}

/**
 * Highest drawn triangle over each sample column, within its height band.
 *
 * One traversal for all columns. Triangles are bucketed by the XZ cell their
 * bounding box covers, so the world's million-odd triangles are rejected by an
 * integer range test before anything trigonometric happens; instanced meshes
 * are rejected per INSTANCE on their own AABB before their triangles are
 * expanded at all, which is what keeps the galley's 18,000 chairs from costing
 * anything here.
 */
function geometryTopAtColumns(world, columns) {
  const CELL = 2;
  const key = (ix, iz) => `${ix},${iz}`;
  /** @type {Map<string, number[]>} */
  const grid = new Map();
  for (let i = 0; i < columns.length; i++) {
    const c = columns[i];
    const k = key(Math.floor(c.x / CELL), Math.floor(c.z / CELL));
    let list = grid.get(k);
    if (!list) grid.set(k, (list = []));
    list.push(i);
  }
  const out = new Array(columns.length).fill(null);

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c3 = new THREE.Vector3();
  const mat = new THREE.Matrix4();
  const bb = new THREE.Box3();

  world.group.updateMatrixWorld(true);
  world.group.traverse((o) => {
    if (!o.isMesh || !o.visible) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m && (m.transparent || m.depthWrite === false)) return;
    const geo = o.geometry;
    const pos = geo?.getAttribute('position');
    if (!pos) return;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const idx = geo.getIndex();
    const n = idx ? idx.count : pos.count;
    const instances = o.isInstancedMesh ? o.count : 1;

    for (let e = 0; e < instances; e++) {
      if (o.isInstancedMesh) o.getMatrixAt(e, mat).premultiply(o.matrixWorld);
      else mat.copy(o.matrixWorld);
      bb.copy(geo.boundingBox).applyMatrix4(mat);
      if (!anyColumnIn(grid, key, CELL, bb)) continue;

      for (let i = 0; i < n; i += 3) {
        const i0 = idx ? idx.getX(i) : i;
        const i1 = idx ? idx.getX(i + 1) : i + 1;
        const i2 = idx ? idx.getX(i + 2) : i + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(mat);
        b.fromBufferAttribute(pos, i1).applyMatrix4(mat);
        c3.fromBufferAttribute(pos, i2).applyMatrix4(mat);
        const x0 = Math.min(a.x, b.x, c3.x), x1 = Math.max(a.x, b.x, c3.x);
        const z0v = Math.min(a.z, b.z, c3.z), z1 = Math.max(a.z, b.z, c3.z);
        for (let ix = Math.floor(x0 / CELL); ix <= Math.floor(x1 / CELL); ix++) {
          for (let iz = Math.floor(z0v / CELL); iz <= Math.floor(z1 / CELL); iz++) {
            const list = grid.get(key(ix, iz));
            if (!list) continue;
            for (const ci of list) {
              const col = columns[ci];
              if (col.x < x0 || col.x > x1 || col.z < z0v || col.z > z1) continue;
              const y = triangleHeightAt(a.x, a.y, a.z, b.x, b.y, b.z, c3.x, c3.y, c3.z, col.x, col.z);
              if (y === null) continue;
              if (y <= col.floorY + 0.02 || y > col.floorY + col.band) continue;
              if (out[ci] === null || y > out[ci]) out[ci] = y;
            }
          }
        }
      }
    }
  });
  return out;
}

function anyColumnIn(grid, key, CELL, bb) {
  for (let ix = Math.floor(bb.min.x / CELL); ix <= Math.floor(bb.max.x / CELL); ix++) {
    for (let iz = Math.floor(bb.min.z / CELL); iz <= Math.floor(bb.max.z / CELL); iz++) {
      if (grid.has(key(ix, iz))) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* The audit                                                           */
/* ------------------------------------------------------------------ */

/**
 * Audit the active station world's placement and collision.
 *
 * Pure-read. Returns a plain JSON-serialisable object; nothing in the world is
 * touched.
 *
 * @param {object} game `window.GAME`
 * @param {{
 *   maxFindings?: number,
 *   checks?: string[],
 *   thresholds?: object,
 *   maxStandaloneSpan?: number,
 *   maxStandaloneTris?: number,
 * }} [opts]
 */
export function auditStation(game, opts = {}) {
  const t0 = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const world = game?.worldManager?.active;
  if (!world || world.id !== 'station') {
    return {
      error: `station audit needs the station world; active world is "${world?.id ?? 'none'}"`,
      meta: { version: AUDIT_VERSION, world: world?.id ?? null },
      checks: [],
    };
  }
  const physics = game.physics;
  const o = {
    maxFindings: opts.maxFindings ?? 400,
    thresholds: { ...THRESHOLDS, ...(opts.thresholds ?? {}) },
    airborneY: opts.airborneY,
    maxStandaloneSpan: opts.maxStandaloneSpan,
    maxStandaloneTris: opts.maxStandaloneTris,
  };
  const want = new Set(opts.checks ?? ['C1', 'C2', 'C3', 'C4', 'C5']);

  const { props, skipped: popSkipped } = collectProps(world, o);
  const mesh = meshColliderIndex(physics);

  const checks = [];
  if (want.has('C1')) checks.push(checkGrounding(props, physics, mesh, o));
  if (want.has('C2')) checks.push(checkOverlap(props, o));
  if (want.has('C3')) checks.push(checkCoverage(props, physics, mesh, o));
  if (want.has('C4')) checks.push(checkEscalators(world, physics, o));
  if (want.has('C5')) checks.push(checkRunBreaks(world, physics, o));

  // Population skips belong to the checks that use the population.
  for (const c of checks) {
    if (c.name === 'C1_GROUNDING') c.skipped = { ...popSkipped, ...c.skipped };
  }

  let drawnMeshes = 0;
  world.group.traverse((x) => { if (x.isMesh && x.visible) drawnMeshes++; });

  const summary = {};
  for (const c of checks) {
    c.findingCount = c.findingCount ?? c.findings.length;
    const byVerdict = {};
    /* Per group as well as per verdict. The hub is settled and collided from
     * its own triangles; the four outer zones are deliberately excluded from
     * both (StationWorld.js:3157) and author their colliders by hand. Those are
     * different worlds as far as this audit is concerned, and a single total
     * hides which of them a number is about. */
    const byGroup = {};
    for (const f of c.findings) {
      byVerdict[f.verdict] = (byVerdict[f.verdict] ?? 0) + 1;
      const g = f.group ?? f.a?.group ?? f.run ?? '(n/a)';
      byGroup[g] = (byGroup[g] ?? 0) + 1;
    }
    if (c.findingCount > c.findings.length) byVerdict['(beyond maxFindings)'] = c.findingCount - c.findings.length;
    c.summary = byVerdict;
    c.byGroup = byGroup;
    summary[c.name] = { examined: c.examined, findings: c.findingCount, byVerdict, byGroup };
  }

  return {
    meta: {
      version: AUDIT_VERSION,
      world: world.id,
      drawnMeshes,
      colliders: physics.colliders.length,
      auditedProps: props.length,
      thresholds: o.thresholds,
      elapsedMs: Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0),
      blindSpots: [
        'GeoBatch merges destroy per-prop identity; merged batch meshes are counted out of the population, not audited (see C1 skipped)',
        'physics.containsPoint has no triangle-soup branch, so C3 corroborates with a direct triangle test before reporting NO_COLLIDER',
        '_collisionSoup drops everything outside DECK_R=200, so outer-zone structure is collided only by boxes; C3 findings there are box coverage only',
        'C1 support is the surface NEAREST the underside among five columns across the footprint, so a prop resting on anything under any part of itself reads as grounded',
        'C1 separates FLOAT from FLOAT_ATTACHED by a 0.35 m overhead ray and a 0.12 m lateral shell; a mounted fixture whose bracket is thinner than that shell is reported as free-standing',
        'the 12 m airborne cut is absolute, so a fixture hung in a 6 m outer-zone arcade is only excused by the attachment test, not by height',
        'the attachment test reads COLLIDERS, and an outer-zone arcade roof is drawn without one, so a downlight bolted to it still reports FLOAT - this is the single largest source of C1 findings in the zone:* groups and is why C1 is reported per group',
      ],
    },
    summary,
    worst: worstFindings(checks, 10),
    checks,
  };
}

/** The ten findings with the largest magnitude, across every check. */
function worstFindings(checks, n) {
  const all = [];
  for (const c of checks) {
    for (const f of c.findings) {
      let magnitude = 0;
      let what = '';
      if (c.name === 'C1_GROUNDING') {
        magnitude = Math.abs(f.gap ?? 0);
        what = `${f.group}/${f.materialKey}[${f.instanceIndex}] gap ${f.gap} at ${f.position.join(', ')}`;
      } else if (c.name === 'C2_OVERLAP') {
        magnitude = f.intersectionVolume;
        what = `${f.a.group}/${f.a.materialKey}[${f.a.instanceIndex}] x ${f.b.group}/${f.b.materialKey}[${f.b.instanceIndex}] ${f.intersectionVolume} m3`;
      } else if (c.name === 'C3_COVERAGE') {
        magnitude = f.size[0] * f.size[1] * f.size[2];
        what = `${f.group}/${f.materialKey}[${f.instanceIndex}] ${f.size.join(' x ')} at ${f.position.join(', ')}`;
      } else if (c.name === 'C4_ESCALATOR') {
        magnitude = f.worstDelta ?? 0;
        what = `bank ${f.bank} run ${f.run} floor ${f.floor} worst delta ${f.worstDelta}`;
      } else if (c.name === 'C5_RUN_BREAKS') {
        magnitude = f.obstructionHeight ?? 0;
        what = `${f.run} at ${f.crossing} obstruction ${f.obstructionHeight} m`;
      }
      all.push({ check: c.name.replace(/_.*/, ''), verdict: f.verdict, magnitude, what });
    }
  }
  all.sort((a, b) => b.magnitude - a.magnitude);
  return all.slice(0, n);
}

export { collectProps, checkGrounding, checkOverlap, checkCoverage, checkEscalators, checkRunBreaks };
