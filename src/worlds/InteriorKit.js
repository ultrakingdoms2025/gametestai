import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * InteriorKit - a small, self-contained builder for walkable building interiors.
 *
 * It is deliberately independent of any single world's texture atlas: it owns a
 * compact flat-PBR material palette so it can be dropped into ANY world. Geometry
 * is batched per-material and merged once in `finish()` (a handful of draw calls),
 * while a few animated pieces (door leaves, the lift car) stay as separate meshes.
 *
 * Design constraints baked in (see Physics.js / WorldManager.js):
 *   - Everything is built axis-aligned in world space, so every collider is an
 *     exact `physics.addBox` and needs no rotated hulls.
 *   - Stairs are individual step boxes with rise <= player stepHeight (0.45), so
 *     the player's step-up probe climbs them naturally.
 *   - The lift is a Y-only moving floor collider (physics.setBoxColliderY), which
 *     is safe because the broadphase grid is XZ-only.
 *   - Doors are a doorway collider whose `.solid` flag is toggled (cheap, no grid
 *     mutation) with matching visual leaves that swing on a hinge pivot.
 *
 * Colliders are registered through `world.track(...)` so the world lifecycle
 * (scratch-build harvest + re-add on activation) carries them automatically, and
 * the SAME collider objects are re-added on activation - so door `.solid` state
 * and the descriptor references survive world switches.
 *
 * `buildTower(spec)` assembles a 3-storey stone guild-tower demonstrating the
 * full loop: openable double door -> furnished ground room -> stairs + elevator
 * -> furnished mid room -> stairs/lift -> rooftop with the prize. Hidden
 * collectibles are returned as spots for a runtime manager to populate.
 */
export class InteriorKit {
  /**
   * @param {import('./World.js').World} world host world (provides group + physics + track)
   * @param {object} [opts]
   */
  constructor(world, opts = {}) {
    this.world = world;
    this.physics = world.physics;
    this.group = new THREE.Group();
    this.group.name = opts.name || 'interior';
    world.group.add(this.group);

    /** @type {Map<string, THREE.BufferGeometry[]>} */
    this._batches = new Map();
    /** Animated / dynamic meshes kept out of the merged batches. */
    this._dynamic = [];

    // Runtime descriptors consumed by the Interiors system.
    this.doors = [];
    this.lifts = [];
    this.collectibleSpots = [];

    this.mats = this._buildMaterials();
    /* Optional per-key material overrides so a host world can swap the flat
     * palette for its own baked/textured PBR materials (e.g. medieval ashlar
     * stone). Overridden batches get box-projected world-scale UVs, a uv1
     * copy for the aoMap channel and a white vertex-colour attribute, because
     * the world materials expect all three (see MedievalWorld.normaliseGeo). */
    this.matOverrides = opts.matOverrides || null;
  }

  /** Material for a palette key, honouring host-world overrides. */
  _mat(key) {
    return (this.matOverrides && this.matOverrides[key]) || this.mats[key];
  }

  /**
   * Prepare a geometry for a host-world textured material: box-projected
   * UVs at world scale (one texture tile per 2m, matching the village bake),
   * a uv1 copy for the aoMap, and white vertex colours.
   */
  _prepGeoForWorldMat(geo, uvPerMetre = 0.5) {
    const pos = geo.attributes.position;
    const nrm = geo.attributes.normal;
    const n = pos.count;
    const uv = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const nx = Math.abs(nrm.getX(i));
      const ny = Math.abs(nrm.getY(i));
      const nz = Math.abs(nrm.getZ(i));
      let u, v;
      if (nx >= ny && nx >= nz) {
        u = pos.getZ(i); v = pos.getY(i);
      } else if (ny >= nz) {
        u = pos.getX(i); v = pos.getZ(i);
      } else {
        u = pos.getX(i); v = pos.getY(i);
      }
      uv[i * 2] = u * uvPerMetre;
      uv[i * 2 + 1] = v * uvPerMetre;
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('uv1', new THREE.BufferAttribute(uv.slice(), 2));
    const col = new Float32Array(n * 3).fill(1);
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    return geo;
  }

  /* ------------------------------------------------------------------ */
  /* Material palette (flat PBR, self-contained)                         */
  /* ------------------------------------------------------------------ */
  _buildMaterials() {
    const std = (color, o = {}) =>
      new THREE.MeshStandardMaterial({
        color,
        roughness: o.roughness ?? 0.9,
        metalness: o.metalness ?? 0.0,
        ...o,
      });
    const mats = {
      stone: std(0x9a958b, { roughness: 0.96 }),
      plaster: std(0xd8cbb2, { roughness: 0.92 }),
      plank: std(0x7a5330, { roughness: 0.82 }),
      beam: std(0x3d2c1a, { roughness: 0.85 }),
      slate: std(0x666a74, { roughness: 0.9 }),
      iron: std(0x40444b, { roughness: 0.5, metalness: 0.72 }),
      fabricRed: std(0x8f3030, { roughness: 0.85 }),
      fabricBlue: std(0x2f4c74, { roughness: 0.85 }),
      linen: std(0xe6e0d2, { roughness: 0.9 }),
      gilt: std(0xc9a24a, { roughness: 0.34, metalness: 0.9 }),
      canvasA: std(0x5f7690, { roughness: 0.85 }),
      canvasB: std(0x6f5a72, { roughness: 0.85 }),
      glass: std(0xaddcff, {
        roughness: 0.08,
        metalness: 0.0,
        transparent: true,
        opacity: 0.32,
      }),
      ember: new THREE.MeshStandardMaterial({
        color: 0x2a1200,
        emissive: 0xff8a3c,
        emissiveIntensity: 2.4,
        roughness: 0.7,
      }),
      lamp: new THREE.MeshStandardMaterial({
        color: 0x2a2410,
        emissive: 0xffd27a,
        emissiveIntensity: 2.0,
        roughness: 0.6,
      }),
    };
    this._ownedMats = Object.values(mats);
    return mats;
  }

  /* ------------------------------------------------------------------ */
  /* Low-level geometry + collider helpers                               */
  /* ------------------------------------------------------------------ */
  _push(matKey, geo) {
    let arr = this._batches.get(matKey);
    if (!arr) {
      arr = [];
      this._batches.set(matKey, arr);
    }
    arr.push(geo);
  }

  /** Visual box (merged). `hx/hy/hz` are half-extents. */
  vbox(matKey, cx, cy, cz, hx, hy, hz) {
    const g = new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2);
    g.translate(cx, cy, cz);
    this._push(matKey, g);
  }

  /** Visual cylinder (merged), aligned to Y. */
  vcyl(matKey, cx, cy, cz, rTop, rBot, h, seg = 10) {
    const g = new THREE.CylinderGeometry(rTop, rBot, h, seg);
    g.translate(cx, cy, cz);
    this._push(matKey, g);
  }

  /** Register an axis-aligned solid box collider, tracked for lifecycle. */
  cbox(cx, cy, cz, hx, hy, hz, opts = {}) {
    return this.world.track(this.physics.addBox(cx, cy, cz, hx, hy, hz, opts));
  }

  /** Visual + collider box in one call. */
  solid(matKey, cx, cy, cz, hx, hy, hz, opts = {}) {
    this.vbox(matKey, cx, cy, cz, hx, hy, hz);
    return this.cbox(cx, cy, cz, hx, hy, hz, opts);
  }

  /** Standalone animated mesh (door leaf / lift car); not merged. */
  _dynMesh(matKey, w, h, d) {
    const geo = new THREE.BoxGeometry(w, h, d);
    const mat = this._mat(matKey);
    if (mat !== this.mats[matKey]) this._prepGeoForWorldMat(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this._dynamic.push(mesh);
    return mesh;
  }

  /** Merge each batch into a single mesh and attach. Call once after building. */
  finish() {
    for (const [matKey, list] of this._batches) {
      if (!list.length) continue;
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (!merged) continue;
      const mat = this._mat(matKey);
      if (mat !== this.mats[matKey]) this._prepGeoForWorldMat(merged);
      const mesh = new THREE.Mesh(merged, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      this.group.add(mesh);
    }
    this._batches.clear();
    return this;
  }

  exportDescriptors() {
    return {
      group: this.group,
      doors: this.doors,
      lifts: this.lifts,
      collectibleSpots: this.collectibleSpots,
    };
  }

  /* ------------------------------------------------------------------ */
  /* Furniture pieces                                                    */
  /* ------------------------------------------------------------------ */
  _rug(cx, cz, y, w, d, matKey) {
    this.vbox(matKey, cx, y + 0.02, cz, w / 2, 0.02, d / 2);
  }

  _table(cx, cz, y) {
    this.vbox('plank', cx, y + 0.78, cz, 0.9, 0.05, 0.55); // top
    const lx = 0.78;
    const lz = 0.43;
    for (const sx of [-lx, lx]) {
      for (const sz of [-lz, lz]) {
        this.vbox('beam', cx + sx, y + 0.38, cz + sz, 0.06, 0.38, 0.06);
      }
    }
    this.cbox(cx, y + 0.4, cz, 0.95, 0.42, 0.6);
  }

  _chair(cx, cz, y, backSide) {
    this.vbox('plank', cx, y + 0.44, cz, 0.24, 0.04, 0.24); // seat
    for (const sx of [-0.18, 0.18]) {
      for (const sz of [-0.18, 0.18]) {
        this.vbox('beam', cx + sx, y + 0.22, cz + sz, 0.04, 0.22, 0.04);
      }
    }
    // Backrest on the requested side (+z/-z/+x/-x).
    if (backSide === '+z') this.vbox('beam', cx, y + 0.72, cz + 0.2, 0.24, 0.26, 0.04);
    else if (backSide === '-z') this.vbox('beam', cx, y + 0.72, cz - 0.2, 0.24, 0.26, 0.04);
    else if (backSide === '+x') this.vbox('beam', cx + 0.2, y + 0.72, cz, 0.04, 0.26, 0.24);
    else this.vbox('beam', cx - 0.2, y + 0.72, cz, 0.04, 0.26, 0.24);
    this.cbox(cx, y + 0.3, cz, 0.26, 0.32, 0.26);
  }

  _bed(cx, cz, y) {
    this.vbox('beam', cx, y + 0.22, cz, 1.05, 0.22, 1.5); // frame
    this.vbox('linen', cx, y + 0.46, cz, 0.98, 0.12, 1.42); // mattress
    this.vbox('fabricRed', cx, y + 0.5, cz, 0.98, 0.06, 0.9); // blanket
    this.vbox('linen', cx, y + 0.56, cz - 1.2, 0.7, 0.1, 0.28); // pillow
    this.vbox('beam', cx, y + 0.72, cz - 1.55, 1.05, 0.5, 0.08); // headboard
    this.cbox(cx, y + 0.32, cz, 1.08, 0.34, 1.55);
  }

  _chest(cx, cz, y) {
    this.vbox('beam', cx, y + 0.24, cz, 0.5, 0.24, 0.34);
    this.vbox('iron', cx, y + 0.28, cz, 0.52, 0.05, 0.36);
    this.cbox(cx, y + 0.26, cz, 0.52, 0.3, 0.36);
  }

  _desk(cx, cz, y, wall) {
    this.vbox('plank', cx, y + 0.76, cz, 0.7, 0.05, 0.4);
    for (const sx of [-0.6, 0.6]) {
      this.vbox('beam', cx + sx, y + 0.38, cz, 0.05, 0.38, 0.35);
    }
    this.cbox(cx, y + 0.4, cz, 0.72, 0.42, 0.42);
  }

  _barrel(cx, cz, y) {
    this.vcyl('plank', cx, y + 0.42, cz, 0.3, 0.34, 0.84, 12);
    this.vbox('iron', cx, y + 0.2, cz, 0.31, 0.03, 0.31);
    this.vbox('iron', cx, y + 0.64, cz, 0.31, 0.03, 0.31);
    this.cbox(cx, y + 0.42, cz, 0.34, 0.44, 0.34);
  }

  _hearth(cx, y, cz, wall) {
    // Recessed fireplace against a wall (wall is '+z'|'-z'|'+x'|'-x').
    const depth = 0.4;
    let ox = 0;
    let oz = 0;
    if (wall === '+z') oz = -depth;
    else if (wall === '-z') oz = depth;
    else if (wall === '+x') ox = -depth;
    else ox = depth;
    this.vbox('stone', cx + ox * 0.4, y + 0.9, cz + oz * 0.4, 0.9, 0.9, 0.5);
    this.vbox('stone', cx + ox * 0.4, y + 1.9, cz + oz * 0.4, 1.1, 0.14, 0.62); // mantel
    // Ember glow inside.
    this.vbox('ember', cx + ox * 0.72, y + 0.42, cz + oz * 0.72, 0.42, 0.18, 0.18);
    this.cbox(cx + ox * 0.4, y + 0.9, cz + oz * 0.4, 0.92, 0.95, 0.52);
  }

  _sconce(cx, cy, cz) {
    this.vbox('iron', cx, cy, cz, 0.06, 0.06, 0.12);
    this.vbox('lamp', cx, cy + 0.16, cz, 0.09, 0.14, 0.09);
  }

  _painting(cx, cy, cz, wall, art) {
    const t = 0.04;
    if (wall === '+z' || wall === '-z') {
      this.vbox('gilt', cx, cy, cz, 0.5, 0.38, t);
      this.vbox(art, cx, cy, cz + (wall === '+z' ? -t : t), 0.42, 0.3, t * 0.6);
    } else {
      this.vbox('gilt', cx, cy, cz, t, 0.38, 0.5);
      this.vbox(art, cx + (wall === '+x' ? -t : t), cy, cz, t * 0.6, 0.3, 0.42);
    }
  }

  _shelf(cx, cy, cz, wall) {
    if (wall === '+x' || wall === '-x') this.vbox('plank', cx, cy, cz, 0.12, 0.04, 0.7);
    else this.vbox('plank', cx, cy, cz, 0.7, 0.04, 0.12);
  }

  _pedestal(cx, cz, y) {
    this.vcyl('stone', cx, y + 0.5, cz, 0.28, 0.34, 1.0, 12);
    this.vcyl('gilt', cx, y + 1.02, cz, 0.3, 0.3, 0.06, 16);
    this.cbox(cx, y + 0.5, cz, 0.34, 0.52, 0.34);
  }

  /* ------------------------------------------------------------------ */
  /* Hero structure: 3-storey guild tower                                */
  /* ------------------------------------------------------------------ */
  /**
   * @param {{ x:number, z:number, baseY:number }} spec
   */
  buildTower(spec) {
    const ox = spec.x;
    const oz = spec.z;
    const y0 = spec.baseY; // ground deck top

    const INT = 5.0; // interior half-width
    const WT = 0.5; // wall thickness (half = 0.25)
    const OUT = INT + WT; // outer half
    const FH = 3.2; // storey height
    const y1 = y0 + FH; // mid deck top
    const y2 = y0 + 2 * FH; // roof deck top
    const wallH = y2 - y0; // 6.4
    const wallHalf = wallH / 2;
    const wallMidY = y0 + wallHalf;

    // Absolute helpers (local -> world).
    const X = (lx) => ox + lx;
    const Z = (lz) => oz + lz;

    /* --- Ground slab (stone, guarantees a flat floor) --- */
    // Deep foundation: top stays at y0, underside buries ~1.2m so that on the
    // downhill side of the terrace apron (where the flattened pad blends back
    // into the natural slope) no gap shows under the walls from outside.
    this.solid('stone', ox, y0 - 0.6, oz, OUT, 0.6, OUT);

    /* --- Exterior walls (ground+mid storeys), north wall has the door --- */
    const HALF_DOOR = 1.2; // opening half-width
    const DOOR_H = 2.6;
    // North (+Z) wall split around the doorway.
    const northZ = Z(OUT - 0.25);
    // left + right jamb segments
    this.solid('stone', ox - (INT + HALF_DOOR) / 2 - 0.0, wallMidY, northZ, (INT - HALF_DOOR) / 2 + 0.25, wallHalf, 0.25);
    this.solid('stone', ox + (INT + HALF_DOOR) / 2 + 0.0, wallMidY, northZ, (INT - HALF_DOOR) / 2 + 0.25, wallHalf, 0.25);
    // lintel above the door
    this.solid('stone', ox, y0 + DOOR_H + (wallH - DOOR_H) / 2, northZ, HALF_DOOR, (wallH - DOOR_H) / 2, 0.25);
    // South, East, West solid walls.
    this.solid('stone', ox, wallMidY, Z(-(OUT - 0.25)), OUT, wallHalf, 0.25); // south
    this.solid('stone', X(OUT - 0.25), wallMidY, oz, 0.25, wallHalf, OUT); // east
    this.solid('stone', X(-(OUT - 0.25)), wallMidY, oz, 0.25, wallHalf, OUT); // west

    /* --- Door: swinging double leaves + a toggle-solid doorway collider --- */
    this._buildDoor(ox, y0, northZ, HALF_DOOR, DOOR_H);

    /* --- Lift shaft (back-right corner, opens toward -X into the room) --- */
    const shaftHalf = 1.2; // 2.4 footprint
    const shaftCX = INT - shaftHalf; // local x centre = 3.8
    const shaftCZ = INT - shaftHalf; // local z centre = 3.8
    // Partition wall on the shaft's -Z (room) side, full height.
    this.solid('stone', X(shaftCX), wallMidY, Z(shaftCZ - shaftHalf - 0.15), shaftHalf + 0.2, wallHalf, 0.15);

    /* --- Decks with holes (mid + roof), plank floors --- */
    // Stair footprint: west side, running +Z.
    const stairHalfW = 0.8; // 1.6 wide
    const stairCX = -(INT - stairHalfW); // local -4.2
    const stairZ0 = -(INT - 0.4); // start near south wall
    const STEP_RISE = 0.4;
    const STEP_TREAD = 0.5;
    const stepCount = Math.ceil(FH / STEP_RISE); // 8
    const stairRun = stepCount * STEP_TREAD; // 4.0
    const stairHoleZ0 = stairZ0 + stairRun - STEP_TREAD; // where the flight emerges
    const stairHoleZ1 = stairZ0 + stairRun + 0.4;

    this._deckWithHoles(ox, oz, y1, INT, {
      holes: [
        { x0: stairCX - stairHalfW, x1: stairCX + stairHalfW, z0: stairHoleZ0, z1: stairHoleZ1 },
        { x0: shaftCX - shaftHalf, x1: shaftCX + shaftHalf, z0: shaftCZ - shaftHalf, z1: shaftCZ + shaftHalf },
      ],
    });
    this._deckWithHoles(ox, oz, y2, INT, {
      holes: [
        { x0: stairCX - stairHalfW, x1: stairCX + stairHalfW, z0: stairHoleZ0, z1: stairHoleZ1 },
        { x0: shaftCX - shaftHalf, x1: shaftCX + shaftHalf, z0: shaftCZ - shaftHalf, z1: shaftCZ + shaftHalf },
      ],
    });

    /* --- Two stair flights (ground->mid, mid->roof), stacked --- */
    this._stairFlight(ox + stairCX, oz, y0, stairZ0, stairHalfW, stepCount, STEP_RISE, STEP_TREAD);
    this._stairFlight(ox + stairCX, oz, y1, stairZ0, stairHalfW, stepCount, STEP_RISE, STEP_TREAD);

    /* --- Elevator (moving floor plate riding between 3 stops) --- */
    this._buildLift(ox + shaftCX, oz + shaftCZ, shaftHalf, [y0, y1, y2]);

    /* --- Roof parapet (safety ring) --- */
    const pH = 1.0;
    this.solid('stone', ox, y2 + pH / 2, Z(OUT - 0.2), OUT, pH / 2, 0.2);
    this.solid('stone', ox, y2 + pH / 2, Z(-(OUT - 0.2)), OUT, pH / 2, 0.2);
    this.solid('stone', X(OUT - 0.2), y2 + pH / 2, oz, 0.2, pH / 2, OUT);
    this.solid('stone', X(-(OUT - 0.2)), y2 + pH / 2, oz, 0.2, pH / 2, OUT);

    /* --- Furnish + decorate + collectible spots --- */
    this._furnishGround(ox, oz, y0, INT);
    this._furnishMid(ox, oz, y1, INT);
    this._furnishRoof(ox, oz, y2, INT);

    // Decorative window insets + glass on solid walls (visual only).
    this._windows(ox, oz, y0, INT, OUT, FH);

    return this;
  }

  /**
   * Compact single-storey interior for bulk rollout across dense districts.
   * Keeps draw/collider cost far below the full 3-floor tower while preserving
   * the enterable loop (door + furnished room + collectible).
   *
   * @param {{ x:number, z:number, baseY:number, intHalf?:number, wallH?:number }} spec
   */
  buildHouse(spec) {
    const ox = spec.x;
    const oz = spec.z;
    const y0 = spec.baseY;

    const INT = Math.max(2.6, spec.intHalf ?? 3.2);
    const WT = 0.36;
    const OUT = INT + WT;
    const wallH = Math.max(2.6, spec.wallH ?? 2.9);
    const wallMidY = y0 + wallH * 0.5;
    const halfDoor = Math.min(1.0, Math.max(0.78, INT * 0.34));
    const doorH = Math.min(2.35, wallH - 0.38);

    const X = (lx) => ox + lx;
    const Z = (lz) => oz + lz;

    // Slightly deep slab so walls never float at blend seams.
    this.solid('stone', ox, y0 - 0.5, oz, OUT, 0.5, OUT);

    const northZ = Z(OUT - 0.22);
    this.solid('stone', ox - (INT + halfDoor) / 2, wallMidY, northZ, (INT - halfDoor) / 2 + 0.24, wallH * 0.5, 0.22);
    this.solid('stone', ox + (INT + halfDoor) / 2, wallMidY, northZ, (INT - halfDoor) / 2 + 0.24, wallH * 0.5, 0.22);
    this.solid('stone', ox, y0 + doorH + (wallH - doorH) * 0.5, northZ, halfDoor, (wallH - doorH) * 0.5, 0.22);
    this.solid('stone', ox, wallMidY, Z(-(OUT - 0.22)), OUT, wallH * 0.5, 0.22);
    this.solid('stone', X(OUT - 0.22), wallMidY, oz, 0.22, wallH * 0.5, OUT);
    this.solid('stone', X(-(OUT - 0.22)), wallMidY, oz, 0.22, wallH * 0.5, OUT);

    this._buildDoor(ox, y0, northZ, halfDoor, doorH);

    // Ceiling cap.
    this.solid('beam', ox, y0 + wallH + 0.12, oz, OUT - 0.04, 0.12, OUT - 0.04);

    // Minimal furnishing.
    this._rug(ox, oz, y0, INT * 1.1, INT * 1.1, 'fabricBlue');
    this._table(ox - INT * 0.2, oz + INT * 0.05, y0);
    this._chair(ox - INT * 0.8, oz + INT * 0.05, y0, '+x');
    this._bed(ox + INT * 0.45, oz - INT * 0.15, y0);
    this._chest(ox + INT * 0.1, oz + INT * 0.75, y0);
    this._windows(ox, oz, y0, INT, OUT, wallH);

    this.collectibleSpots.push({
      position: new THREE.Vector3(ox, y0 + 0.62, oz),
      tier: 'common',
    });

    return this;
  }

  /**
   * Large two-storey parish church interior/exterior shell for authored
   * landmark buildings (guaranteed enterables, not rollout-generated).
   *
   * @param {{ x:number, z:number, baseY:number, halfW?:number, halfD?:number }} spec
   */
  buildChurch(spec) {
    const ox = spec.x;
    const oz = spec.z;
    const y0 = spec.baseY;

    const INT_W = Math.max(4.2, spec.halfW ?? 4.8);
    const INT_D = Math.max(6.2, spec.halfD ?? 7.6);
    const WT = 0.42;
    const OUT_W = INT_W + WT;
    const OUT_D = INT_D + WT;
    const wallH = 6.4;
    const wallMidY = y0 + wallH * 0.5;
    const halfDoor = 1.1;
    const doorH = 2.9;

    // Deep slab to keep the floor sealed on uneven terrain.
    this.solid('stone', ox, y0 - 0.62, oz, OUT_W, 0.62, OUT_D);

    // Nave walls with front/back doorways (+Z and -Z sides).
    // Jamb panels span exactly from the door edge (halfDoor) to the outer
    // corner (OUT_W) so the leaves never intersect the wall.
    const jambC = (halfDoor + OUT_W) / 2;
    const jambH = (OUT_W - halfDoor) / 2;
    const northZ = oz + OUT_D - 0.24;
    const southZ = oz - (OUT_D - 0.24);
    for (const wz of [northZ, southZ]) {
      this.solid('stone', ox - jambC, wallMidY, wz, jambH, wallH * 0.5, 0.24);
      this.solid('stone', ox + jambC, wallMidY, wz, jambH, wallH * 0.5, 0.24);
      this.solid('stone', ox, y0 + doorH + (wallH - doorH) * 0.5, wz, halfDoor, (wallH - doorH) * 0.5, 0.24);
    }
    this.solid('stone', ox + (OUT_W - 0.24), wallMidY, oz, 0.24, wallH * 0.5, OUT_D);
    this.solid('stone', ox - (OUT_W - 0.24), wallMidY, oz, 0.24, wallH * 0.5, OUT_D);

    this._buildDoor(ox, y0, northZ, halfDoor, doorH);
    this._buildDoor(ox, y0, southZ, halfDoor, doorH);

    // Rear half mezzanine (second storey) + stair.
    const loftY = y0 + 3.25;
    const deckCZ = oz - INT_D * 0.34;
    // Stair flight geometry (west wall, climbing north): mirrored below so the
    // deck can carry a matching stairwell hole above the flight.
    const stairSteps = 13;
    const stairRise = 0.25;
    const stairTread = 0.48;
    const stairZ0 = -INT_D + 1.15; // local to oz
    const stairRun = stairSteps * stairTread;
    this._deckWithHoles(ox, deckCZ, loftY, INT_W - 0.1, {
      holes: [
        { x0: -0.9, x1: 0.9, z0: -INT_D * 0.46, z1: INT_D * 0.46 },
        // Stairwell (deck-local z = world z - deckCZ).
        {
          x0: -INT_W + 0.2,
          x1: -INT_W + 1.9,
          z0: stairZ0 + INT_D * 0.34 - 0.3,
          z1: stairZ0 + INT_D * 0.34 + stairRun + 0.9,
        },
      ],
    });
    this._stairFlight(ox - INT_W + 0.95, oz, y0, stairZ0, 0.62, stairSteps, stairRise, stairTread);

    // Pitched roof: two planes from the eaves (x = +-OUT_W, y = y0+wallH) up
    // to the ridge (x = 0). Each slab is a slabLen-long, 0.24-thick box laid
    // along X and tilted about Z so its ends meet the eave and ridge.
    const roofRise = OUT_W * 0.9;
    const slope = Math.atan2(roofRise, OUT_W);
    const slabLen = Math.hypot(OUT_W, roofRise) + 0.55;
    const ridgeY = y0 + wallH + roofRise;
    const roofDepth = (OUT_D + 0.35) * 2;
    const roofMidY = y0 + wallH + roofRise * 0.5;
    const roofA = this._dynMesh('slate', slabLen, 0.24, roofDepth);
    roofA.position.set(ox - OUT_W * 0.5, roofMidY, oz);
    roofA.rotation.z = slope; // west slab: +X end (toward ridge) tilts up
    const roofB = this._dynMesh('slate', slabLen, 0.24, roofDepth);
    roofB.position.set(ox + OUT_W * 0.5, roofMidY, oz);
    roofB.rotation.z = -slope; // east slab mirrors it
    this.group.add(roofA, roofB);
    this.vbox('slate', ox, ridgeY + 0.1, oz, 0.42, 0.14, OUT_D + 0.35);

    // Gable infill so the roof ends are sealed (stepped stone triangles).
    for (const gz of [northZ, southZ]) {
      for (let s = 0; s < 4; s++) {
        const t = (s + 0.5) / 4;
        const gw = OUT_W * (1 - t);
        const gh = roofRise / 8;
        this.vbox('stone', ox, y0 + wallH + roofRise * t, gz, gw, gh, 0.24);
      }
    }

    // Bell tower and spire straddling the ridge at the rear gable.
    const towerZ = oz - OUT_D + 1.15;
    this.solid('stone', ox, ridgeY + 0.9, towerZ, 1.45, 1.35, 1.45);
    this.vbox('stone', ox, ridgeY + 2.55, towerZ, 1.12, 0.45, 1.12);
    this.vcyl('gilt', ox, ridgeY + 3.65, towerZ, 0.12, 0.98, 1.7, 10);

    // Tall lancet windows.
    const winY = [y0 + 2.2, y0 + 4.4];
    for (const cy of winY) {
      for (const sx of [-1, 1]) {
        this.vbox('beam', ox + sx * (OUT_W - 0.22), cy, oz - 2.4, 0.05, 0.92, 0.42);
        this.vbox('glass', ox + sx * (OUT_W - 0.18), cy, oz - 2.4, 0.02, 0.78, 0.32);
        this.vbox('beam', ox + sx * (OUT_W - 0.22), cy, oz + 2.1, 0.05, 0.92, 0.42);
        this.vbox('glass', ox + sx * (OUT_W - 0.18), cy, oz + 2.1, 0.02, 0.78, 0.32);
      }
    }

    // Nave furnishing.
    this._rug(ox, oz + 1.6, y0, INT_W * 1.25, INT_D * 0.82, 'fabricRed');
    for (let r = 0; r < 5; r++) {
      const z = oz + 4.8 - r * 1.8;
      this.vbox('plank', ox - 1.8, y0 + 0.48, z, 1.2, 0.06, 0.24);
      this.vbox('plank', ox + 1.8, y0 + 0.48, z, 1.2, 0.06, 0.24);
      this.cbox(ox - 1.8, y0 + 0.48, z, 1.2, 0.08, 0.28);
      this.cbox(ox + 1.8, y0 + 0.48, z, 1.2, 0.08, 0.28);
    }
    this._pedestal(ox, oz - INT_D + 1.4, y0);
    this._sconce(ox - INT_W + 0.38, y0 + 2.1, oz + INT_D - 2.0);
    this._sconce(ox + INT_W - 0.38, y0 + 2.1, oz + INT_D - 2.0);

    this.collectibleSpots.push(
      { position: new THREE.Vector3(ox, y0 + 0.7, oz + 0.2), tier: 'common' },
      { position: new THREE.Vector3(ox, loftY + 0.7, oz - INT_D * 0.34), tier: 'rare' }
    );

    return this;
  }

  /* --- Door assembly --------------------------------------------------- */
  _buildDoor(ox, y0, doorZ, halfDoor, doorH) {
    const leafW = halfDoor; // each leaf covers half the opening
    const leafH = doorH;
    const thick = 0.12;
    const cy = y0 + doorH / 2;

    // Two hinge pivots at the jambs; leaves offset toward the centre.
    const makeLeaf = (hingeX, dir) => {
      const pivot = new THREE.Group();
      pivot.position.set(hingeX, cy, doorZ);
      const leaf = this._dynMesh('beam', leafW, leafH, thick);
      leaf.position.set((dir * leafW) / 2, 0, 0);
      // Iron band accents.
      const bandGeo = new THREE.BoxGeometry(leafW * 0.9, 0.1, thick + 0.02);
      const bandMat = this._mat('iron');
      if (bandMat !== this.mats.iron) this._prepGeoForWorldMat(bandGeo);
      const band = new THREE.Mesh(bandGeo, bandMat);
      band.position.set((dir * leafW) / 2, leafH * 0.28, 0);
      const band2 = band.clone();
      band2.position.y = -leafH * 0.28;
      pivot.add(leaf, band, band2);
      pivot.matrixAutoUpdate = true;
      this.group.add(pivot);
      return pivot;
    };
    const left = makeLeaf(ox - halfDoor, +1);
    const right = makeLeaf(ox + halfDoor, -1);

    // Doorway blocker collider (toggle .solid). Starts closed (solid).
    const collider = this.cbox(ox, cy, doorZ, halfDoor, doorH / 2, 0.14, { solid: true });

    this.doors.push({
      id: `door_${this.doors.length}`,
      leaves: [
        { pivot: left, closed: 0, open: -Math.PI * 0.62 },
        { pivot: right, closed: 0, open: Math.PI * 0.62 },
      ],
      collider,
      position: new THREE.Vector3(ox, y0 + 1.0, doorZ),
      open: false,
      anim: 0, // 0 closed .. 1 open
    });
  }

  /* --- Deck slab with rectangular holes (local hole coords) ------------ */
  _deckWithHoles(ox, oz, y, INT, { holes }) {
    // Build the deck as a grid of panels, skipping any panel that overlaps a hole.
    const N = 10; // 10x10 panels across the interior (each ~1.0m)
    const cell = (INT * 2) / N;
    const half = cell / 2;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const lx = -INT + half + i * cell;
        const lz = -INT + half + j * cell;
        let blocked = false;
        for (const h of holes) {
          if (lx + half > h.x0 && lx - half < h.x1 && lz + half > h.z0 && lz - half < h.z1) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        this.vbox('plank', ox + lx, y - 0.1, oz + lz, half, 0.1, half);
      }
    }
    // Colliders: cover the deck with a few large boxes minus the hole bands is
    // complex; instead register one collider per non-hole panel row segment.
    // Simpler + robust: register colliders per panel (cheap; grid is coarse).
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const lx = -INT + half + i * cell;
        const lz = -INT + half + j * cell;
        let blocked = false;
        for (const h of holes) {
          if (lx + half > h.x0 && lx - half < h.x1 && lz + half > h.z0 && lz - half < h.z1) {
            blocked = true;
            break;
          }
        }
        if (blocked) continue;
        this.cbox(ox + lx, y - 0.1, oz + lz, half, 0.1, half);
      }
    }
  }

  /* --- Stair flight (individual step boxes) ---------------------------- */
  _stairFlight(cx, oz, yBase, z0Local, halfW, steps, rise, tread) {
    for (let i = 0; i < steps; i++) {
      const topY = yBase + (i + 1) * rise;
      const cz = oz + z0Local + i * tread + tread / 2;
      const cy = topY - 0.25;
      this.vbox('plank', cx, cy, cz, halfW, 0.25, tread / 2 + 0.02);
      this.cbox(cx, cy, cz, halfW, 0.25, tread / 2 + 0.02);
    }
  }

  /* --- Elevator: moving floor plate + car visuals --------------------- */
  _buildLift(cx, cz, half, stops) {
    const plateThick = 0.18;
    const stop0 = stops[0];
    // Moving floor collider: top surface at the stop Y => centre = stopY - thick/2.
    const collider = this.cbox(cx, stop0 - plateThick / 2, cz, half - 0.05, plateThick / 2, half - 0.05);

    // Car visual (moves with the collider): floor plate + rails + emissive strip.
    const car = new THREE.Group();
    car.matrixAutoUpdate = true;
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry((half - 0.05) * 2, plateThick, (half - 0.05) * 2),
      this.mats.iron
    );
    plate.position.y = -plateThick / 2;
    plate.castShadow = true;
    plate.receiveShadow = true;
    // Corner posts + a glow strip so the car reads as an elevator.
    const post = (px, pz) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.1, 0.1), this.mats.iron);
      m.position.set(px, 0.55, pz);
      return m;
    };
    const glow = new THREE.Mesh(
      new THREE.BoxGeometry((half - 0.1) * 2, 0.08, 0.06),
      this.mats.lamp
    );
    glow.position.set(0, 1.05, half - 0.12);
    car.add(
      plate,
      post(half - 0.12, half - 0.12),
      post(-(half - 0.12), half - 0.12),
      post(half - 0.12, -(half - 0.12)),
      post(-(half - 0.12), -(half - 0.12)),
      glow
    );
    car.position.set(cx, stop0, cz);
    this.group.add(car);

    // Call panel marker at the -X entrance of each stop (visual only).
    for (const sy of stops) {
      this.vbox('lamp', cx - half - 0.02, sy + 1.3, cz, 0.03, 0.12, 0.1);
    }

    this.lifts.push({
      id: `lift_${this.lifts.length}`,
      collider,
      car,
      plateThick,
      stops: stops.slice(),
      stopIndex: 0,
      target: 0,
      pos: stop0, // current plate-top Y
      speed: 2.6,
      // Entrance is at -X; call point sits just outside the plate on that side.
      callPos: new THREE.Vector3(cx - half - 0.6, stop0, cz),
      footprint: { cx, cz, half },
    });
  }

  /* --- Decorative windows (insets + glass, no collider gaps) ---------- */
  _windows(ox, oz, y0, INT, OUT, FH) {
    const wy = [y0 + 1.5, y0 + FH + 1.5];
    const place = (cx, cy, cz, wall) => {
      const t = 0.06;
      if (wall === 'south' || wall === 'north') {
        this.vbox('beam', cx, cy, cz, 0.72, 0.62, t);
        this.vbox('glass', cx, cy, cz + (wall === 'south' ? 0.04 : -0.04), 0.6, 0.5, t * 0.4);
      } else {
        this.vbox('beam', cx, cy, cz, t, 0.62, 0.72);
        this.vbox('glass', cx + (wall === 'west' ? 0.04 : -0.04), cy, cz, t * 0.4, 0.5, 0.6);
      }
    };
    for (const cy of wy) {
      place(ox - 2.4, cy, oz - (OUT - 0.24), 'south');
      place(ox + 2.4, cy, oz - (OUT - 0.24), 'south');
      place(ox + (OUT - 0.24), cy, oz - 2.2, 'east');
      place(ox - (OUT - 0.24), cy, oz + 2.6, 'west');
    }
  }

  /* --- Furnishing ------------------------------------------------------ */
  _furnishGround(ox, oz, y0, INT) {
    // Central rug + dining table with chairs.
    this._rug(ox, oz + 0.2, y0, 3.0, 2.4, 'fabricBlue');
    this._table(ox, oz + 0.2, y0);
    this._chair(ox - 1.15, oz + 0.2, y0, '-x');
    this._chair(ox + 1.15, oz + 0.2, y0, '+x');
    this._chair(ox, oz + 1.0, y0, '+z');
    this._chair(ox, oz - 0.6, y0, '-z');
    // Hearth on the south wall.
    this._hearth(ox - 2.6, y0, oz - (INT - 0.3), '-z');
    // Barrels + shelf near the east wall.
    this._barrel(ox + INT - 0.7, oz - 2.6, y0);
    this._barrel(ox + INT - 1.3, oz - 2.6, y0);
    this._shelf(ox + INT - 0.35, y0 + 1.7, oz - 1.4, '+x');
    this._shelf(ox + INT - 0.35, y0 + 2.2, oz - 1.4, '+x');
    // Sconces + paintings.
    this._sconce(ox - INT + 0.3, y0 + 2.2, oz - 1.0);
    this._sconce(ox - INT + 0.3, y0 + 2.2, oz + 1.6);
    this._painting(ox, y0 + 2.1, oz - (INT - 0.28), '-z', 'canvasA');
    // Hidden collectible: on the table.
    this.collectibleSpots.push({
      position: new THREE.Vector3(ox + 0.5, y0 + 0.95, oz + 0.2),
      tier: 'common',
    });
  }

  _furnishMid(ox, oz, y1, INT) {
    // Bedroom: bed against the north-east, desk on the south wall.
    this._rug(ox - 0.5, oz - 0.5, y1, 2.6, 2.2, 'fabricRed');
    this._bed(ox + 2.4, oz + 2.2, y1);
    this._chest(ox + 2.4, oz + 0.4, y1);
    this._desk(ox - 1.6, oz - (INT - 0.6), y1, '-z');
    this._chair(ox - 1.6, oz - (INT - 1.4), y1, '-z');
    this._barrel(ox - INT + 0.7, oz + 2.4, y1);
    this._sconce(ox + INT - 0.3, y1 + 2.0, oz - 0.4);
    this._sconce(ox - INT + 0.3, y1 + 2.0, oz + 0.4);
    this._painting(ox + INT - 0.28, y1 + 2.0, oz + 2.2, '+x', 'canvasB');
    this._painting(ox - INT + 0.28, y1 + 2.0, oz - 1.6, '-x', 'canvasA');
    // Hidden collectible: tucked behind the chest / on the desk.
    this.collectibleSpots.push({
      position: new THREE.Vector3(ox - 1.6, y1 + 0.95, oz - (INT - 0.6)),
      tier: 'rare',
    });
  }

  _furnishRoof(ox, oz, y2, INT) {
    // Rooftop viewing platform: pedestal holds the prize.
    this._pedestal(ox, oz - 0.5, y2);
    this._sconce(ox + 1.6, y2 + 0.4, oz + 1.6);
    this._sconce(ox - 1.6, y2 + 0.4, oz + 1.6);
    // A bench + banner-post flavour.
    this.vbox('plank', ox + 2.4, y2 + 0.4, oz + 1.0, 0.7, 0.06, 0.24);
    this.cbox(ox + 2.4, y2 + 0.3, oz + 1.0, 0.7, 0.3, 0.24);
    this.vcyl('beam', ox - 3.0, y2 + 1.4, oz - 3.0, 0.08, 0.1, 2.8, 8);
    this.vbox('fabricRed', ox - 3.0, y2 + 2.2, oz - 3.0 + 0.5, 0.02, 0.7, 0.5);
    // The prize.
    this.collectibleSpots.push({
      position: new THREE.Vector3(ox, y2 + 1.2, oz - 0.5),
      tier: 'prize',
    });
  }
}
