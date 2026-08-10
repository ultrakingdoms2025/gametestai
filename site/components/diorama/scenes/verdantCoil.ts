import type * as THREE from 'three';
import type { DioramaScene, SceneCtx, QualityTier } from '../types';
import { mulberry32, smoothstep, lerp, TAU } from '@/lib/sceneMath';

/**
 * The Verdant Coil — the puzzle-world diorama (id 'maze').
 *
 * Composition (world units, 50° fov camera at ~2–23 units):
 * - a dark loam ground plane,
 * - a 14×14-cell hedge maze built from ONE shared box geometry, instanced
 *   per surviving wall segment (binary-tree carve — see `carveMazeLayout`),
 * - a lush outer hedge ring (torus, static, never reshuffles) plus a thin
 *   additive rim-glow torus just outside it,
 * - THE SIGNATURE — re-threading: three maze layouts (A/B/C) are carved at
 *   build time from three different seeds, each held in its own
 *   InstancedMesh + material. `update()` cross-dissolves their material
 *   opacity as `progress` crosses two thresholds (~0.33, ~0.66), so hedges
 *   visibly dissolve and re-grow elsewhere — the maze cannot be learned,
 * - the Keeper's lantern: a small post + warm amber bulb + additive glow
 *   shell at a fixed lane intersection, with its own point light — the only
 *   warm note in an otherwise cool green scene,
 * - a seeded, ≤600-point pale-green spore field drifting slowly upward,
 * - green-tinted dark `FogExp2`, dim cool ambient, a pale green-white
 *   directional "moonlight", and accent-tinted emissive hedge rims.
 *
 * Determinism rule: camera position/orientation AND the layout cross-dissolve
 * weights derive purely from `progress` (see station.ts for the reference) —
 * the re-thread is a scrub effect, not an animation, so scrubbing back and
 * forth must retrace it exactly. Only ambient drift (spore drift, lantern
 * flicker) accumulates via `dt`. All three maze layouts and the spore field
 * are seeded (mulberry32) for build-to-build determinism.
 */

const N = 14; // maze grid, N×N cells
const CELL = 1.25;
const HEDGE_HEIGHT = 1.05;
const HEDGE_THICKNESS = 0.2;
const GRID_EXTENT = (N - 1) * CELL;
const HALF = GRID_EXTENT / 2;
const RING_RADIUS = HALF + 1.6;
const RING_TUBE = 0.55;
const SPORE_COUNT = 600;

const LANTERN_POS = { x: CELL * 1.5, z: -CELL * 2.5 };

// Camera endpoints — start near-overhead (slightly off-axis so `lookAt`
// never points exactly down the up-axis), end low near the lantern.
const CAM_TOP = { x: 0.45, y: 23, z: 0.35 };
const CAM_END = { x: LANTERN_POS.x - 1.6, y: HEDGE_HEIGHT + 0.85, z: LANTERN_POS.z + 2.0 };
const LOOK_TOP = { x: 0, y: 0, z: 0 };
const LOOK_END = { x: LANTERN_POS.x, y: 0.5, z: LANTERN_POS.z };

// Cross-dissolve schedule for the three maze layouts — pure function of
// `progress`, see `layoutWeights` below.
const LAYOUT_THRESHOLDS: [number, number] = [0.33, 0.66];
const LAYOUT_FADE_HALF = 0.09;

interface HedgeWall {
  x: number;
  z: number;
  sx: number;
  sz: number;
}

interface Spore {
  baseX: number;
  baseY: number;
  baseZ: number;
  driftSpeed: number;
  driftRange: number;
  phase: number;
}

/**
 * Binary-tree maze carve: for every cell, removes its north wall or its east
 * wall (or whichever of the two is actually available at the grid's top row
 * / right column — the top-right corner has neither and carves nothing).
 * The result is a fully connected spanning-tree maze with no separate
 * border pass needed, since the array bounds themselves form the perimeter
 * (a static outer hedge ring is drawn separately for the visual edge).
 * Pure and seeded via `rand`, so the same generator sequence always yields
 * the same wall layout.
 */
function carveMazeLayout(rand: () => number, n: number, cell: number, thickness: number): HedgeWall[] {
  const cellX = (c: number) => (c - (n - 1) / 2) * cell;
  const cellZ = (r: number) => (r - (n - 1) / 2) * cell;
  const northPresent: boolean[][] = Array.from({ length: n }, () => new Array(n).fill(true));
  const eastPresent: boolean[][] = Array.from({ length: n }, () => new Array(n).fill(true));

  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const canNorth = r > 0;
      const canEast = c < n - 1;
      if (!canNorth && !canEast) continue; // top-right corner: nothing to carve
      const carveNorth = !canEast ? true : !canNorth ? false : rand() < 0.5;
      if (carveNorth) northPresent[r][c] = false;
      else eastPresent[r][c] = false;
    }
  }

  const walls: HedgeWall[] = [];
  const wallLen = cell * 0.92;
  for (let r = 1; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (northPresent[r][c]) {
        walls.push({ x: cellX(c), z: cellZ(r) - cell / 2, sx: wallLen, sz: thickness });
      }
    }
  }
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n - 1; c++) {
      if (eastPresent[r][c]) {
        walls.push({ x: cellX(c) + cell / 2, z: cellZ(r), sx: thickness, sz: wallLen });
      }
    }
  }
  return walls;
}

/**
 * Cross-dissolve weights for the three seeded maze layouts, purely a
 * function of `progress` (never `dt`) — this is what makes the maze visibly
 * re-thread itself as the panel is scrubbed: layout A holds until the first
 * threshold, smoothly dissolves into B, holds, then dissolves into C.
 */
function layoutWeights(p: number): { a: number; b: number; c: number } {
  const [t1, t2] = LAYOUT_THRESHOLDS;
  const h = LAYOUT_FADE_HALF;
  const fade = (center: number): number => {
    const t = (p - (center - h)) / (2 * h);
    return smoothstep(Math.min(Math.max(t, 0), 1));
  };
  if (p <= t1 - h) return { a: 1, b: 0, c: 0 };
  if (p <= t1 + h) {
    const f = fade(t1);
    return { a: 1 - f, b: f, c: 0 };
  }
  if (p <= t2 - h) return { a: 0, b: 1, c: 0 };
  if (p <= t2 + h) {
    const f = fade(t2);
    return { a: 0, b: 1 - f, c: f };
  }
  return { a: 0, b: 0, c: 1 };
}

export function createVerdantCoilScene(): DioramaScene {
  // --- closure state, populated once in build() -----------------------------
  let ctx: SceneCtx | null = null;
  let root: THREE.Group | null = null;
  const disposables: Array<{ dispose(): void }> = [];

  let detail: THREE.Group | null = null; // rim glow + lantern glow shell — culled on 'low'
  let hedgeA: THREE.InstancedMesh | null = null;
  let hedgeB: THREE.InstancedMesh | null = null;
  let hedgeC: THREE.InstancedMesh | null = null;
  let hedgeMatA: THREE.MeshLambertMaterial | null = null;
  let hedgeMatB: THREE.MeshLambertMaterial | null = null;
  let hedgeMatC: THREE.MeshLambertMaterial | null = null;
  let spores: THREE.Points | null = null;
  let sporePositions: Float32Array | null = null;
  let sporeData: Spore[] = [];
  let lanternLight: THREE.PointLight | null = null;

  let tier: QualityTier = 'high';
  // Ambient accumulators — the ONLY dt-driven state (see determinism rule).
  let driftTime = 0;

  function track<T extends { dispose(): void }>(d: T): T {
    disposables.push(d);
    return d;
  }

  function sporeCount(): number {
    return tier === 'high' ? SPORE_COUNT : tier === 'medium' ? 380 : 200;
  }

  function applyQuality(): void {
    if (!spores || !detail) return;
    spores.geometry.setDrawRange(0, sporeCount());
    detail.visible = tier !== 'low';
  }

  function build(c: SceneCtx): void {
    ctx = c;
    tier = c.quality;
    const { THREE, scene, accent } = c;

    scene.fog = new THREE.FogExp2(0x061109, 0.045);

    root = new THREE.Group();
    scene.add(root);
    detail = new THREE.Group();

    // --- lighting: dim cool moonlight, the lantern's warm point light added below --
    root.add(new THREE.AmbientLight(0x18261c, 0.45));
    const moon = new THREE.DirectionalLight(0xcfe8d8, 0.55);
    moon.position.set(3, 30, -4);
    root.add(moon);

    // --- ground plane (dark loam) --------------------------------------------
    const groundGeo = track(new THREE.PlaneGeometry(GRID_EXTENT + 10, GRID_EXTENT + 10));
    const groundMat = track(
      new THREE.MeshLambertMaterial({ color: 0x070b06, emissive: 0x020402 }),
    );
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    root.add(ground);

    // --- lush outer hedge ring (static — never reshuffles) --------------------
    const ringGeo = track(new THREE.TorusGeometry(RING_RADIUS, RING_TUBE, 10, 48));
    const ringMat = track(
      new THREE.MeshLambertMaterial({
        color: 0x0c2712,
        emissive: accent.getHex(),
        emissiveIntensity: 0.3,
      }),
    );
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = RING_TUBE;
    root.add(ring);

    const glowRingGeo = track(new THREE.TorusGeometry(RING_RADIUS + RING_TUBE * 0.9, 0.05, 8, 48));
    const glowRingMat = track(
      new THREE.MeshBasicMaterial({
        color: accent.getHex(),
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.45,
        depthWrite: false,
      }),
    );
    const glowRing = new THREE.Mesh(glowRingGeo, glowRingMat);
    glowRing.rotation.x = Math.PI / 2;
    glowRing.position.y = RING_TUBE * 1.5;
    detail.add(glowRing);

    // --- THE SIGNATURE: three seeded hedge-maze layouts, cross-dissolved below --
    const hedgeGeo = track(new THREE.BoxGeometry(1, 1, 1));
    function makeLayoutMesh(seed: number): { mesh: THREE.InstancedMesh; mat: THREE.MeshLambertMaterial } {
      const rand = mulberry32(seed);
      const walls = carveMazeLayout(rand, N, CELL, HEDGE_THICKNESS);
      const mat = track(
        new THREE.MeshLambertMaterial({
          color: 0x0e2d16,
          emissive: accent.getHex(),
          emissiveIntensity: 0.22,
          transparent: true,
          opacity: 1,
          depthWrite: false,
        }),
      );
      const mesh = new THREE.InstancedMesh(hedgeGeo, mat, walls.length);
      const m = new THREE.Matrix4();
      for (let i = 0; i < walls.length; i++) {
        const w = walls[i];
        m.makeScale(w.sx, HEDGE_HEIGHT, w.sz);
        m.setPosition(w.x, HEDGE_HEIGHT / 2, w.z);
        mesh.setMatrixAt(i, m);
      }
      mesh.instanceMatrix.needsUpdate = true;
      return { mesh, mat };
    }
    const layoutA = makeLayoutMesh(0x4d61_7a41); // 'MazA' seed — fixed forever
    const layoutB = makeLayoutMesh(0x4d61_7a42); // 'MazB' seed — fixed forever
    const layoutC = makeLayoutMesh(0x4d61_7a43); // 'MazC' seed — fixed forever
    hedgeA = layoutA.mesh;
    hedgeMatA = layoutA.mat;
    hedgeB = layoutB.mesh;
    hedgeMatB = layoutB.mat;
    hedgeC = layoutC.mesh;
    hedgeMatC = layoutC.mat;
    hedgeMatA.opacity = 1;
    hedgeMatB.opacity = 0;
    hedgeMatC.opacity = 0;
    root.add(hedgeA, hedgeB, hedgeC);

    // --- the Keeper's lantern (the only warm note in the scene) ---------------
    const lanternPoleGeo = track(new THREE.CylinderGeometry(0.035, 0.05, 0.85, 6));
    const lanternPoleMat = track(
      new THREE.MeshLambertMaterial({ color: 0x1c1712, emissive: 0x050402 }),
    );
    const lanternPole = new THREE.Mesh(lanternPoleGeo, lanternPoleMat);
    lanternPole.position.set(LANTERN_POS.x, 0.425, LANTERN_POS.z);
    root.add(lanternPole);

    const lanternBulbGeo = track(new THREE.SphereGeometry(0.11, 10, 8));
    const lanternBulbMat = track(new THREE.MeshBasicMaterial({ color: 0xffb15c }));
    const lanternBulb = new THREE.Mesh(lanternBulbGeo, lanternBulbMat);
    lanternBulb.position.set(LANTERN_POS.x, 0.92, LANTERN_POS.z);
    root.add(lanternBulb);

    const lanternGlowGeo = track(new THREE.SphereGeometry(0.22, 10, 8));
    const lanternGlowMat = track(
      new THREE.MeshBasicMaterial({
        color: 0xffb15c,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.4,
        depthWrite: false,
      }),
    );
    const lanternGlow = new THREE.Mesh(lanternGlowGeo, lanternGlowMat);
    lanternGlow.position.copy(lanternBulb.position);
    detail.add(lanternGlow);

    lanternLight = new THREE.PointLight(0xffa752, 1.3, 6, 2);
    lanternLight.position.copy(lanternBulb.position);
    root.add(lanternLight);

    root.add(detail);

    // --- spore field (seeded, drifting slowly upward) -------------------------
    const sporeRand = mulberry32(0x5370_7265); // 'Spre' seed — fixed forever
    sporeData = [];
    for (let i = 0; i < SPORE_COUNT; i++) {
      sporeData.push({
        baseX: (sporeRand() - 0.5) * (GRID_EXTENT + 6),
        baseY: 0.2 + sporeRand() * 2.4,
        baseZ: (sporeRand() - 0.5) * (GRID_EXTENT + 6),
        driftSpeed: 0.04 + sporeRand() * 0.07,
        driftRange: 0.5 + sporeRand() * 1.0,
        phase: sporeRand() * TAU,
      });
    }
    sporePositions = new Float32Array(SPORE_COUNT * 3);
    const sporeGeo = track(new THREE.BufferGeometry());
    const sporeAttr = new THREE.BufferAttribute(sporePositions, 3);
    sporeAttr.setUsage(THREE.DynamicDrawUsage); // rewritten every frame in placeSpores()
    sporeGeo.setAttribute('position', sporeAttr);
    const sporeMat = track(
      new THREE.PointsMaterial({
        color: 0xcdeecb,
        size: 0.05,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      }),
    );
    spores = new THREE.Points(sporeGeo, sporeMat);
    spores.frustumCulled = false; // positions mutate every frame; skip stale-bounds culling
    root.add(spores);
    placeSpores(); // lay out at t=0 so the first frame isn't a clump at origin

    applyQuality();
  }

  function placeSpores(): void {
    if (!spores || !sporePositions) return;
    const n = sporeCount();
    for (let i = 0; i < n; i++) {
      const s = sporeData[i];
      const riseT = ((driftTime * s.driftSpeed + s.phase) % s.driftRange) / s.driftRange;
      sporePositions[i * 3] = s.baseX + Math.sin(driftTime * 0.2 + s.phase) * 0.4;
      sporePositions[i * 3 + 1] = s.baseY + riseT * s.driftRange;
      sporePositions[i * 3 + 2] = s.baseZ + Math.cos(driftTime * 0.18 + s.phase) * 0.4;
    }
    (spores.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  function update(dt: number, progress: number, active: boolean): void {
    if (!active) return;
    if (!ctx || !root) return; // not built yet — DioramaCanvas never does this, but stay safe

    // --- camera: pure function of progress ---------------------------------
    // Start directly overhead (the whole coil legible), descend in one slow
    // spiral revolution to a low oblique angle just above the hedge tops
    // near the lantern, as if being drawn in.
    const clamped = Math.min(Math.max(progress, 0), 1);
    const p = smoothstep(clamped);
    const lerpX = lerp(CAM_TOP.x, CAM_END.x, p);
    const lerpZ = lerp(CAM_TOP.z, CAM_END.z, p);
    const spiralAngle = p * TAU; // exactly one revolution — start/end angle match the raw lerp
    const cosA = Math.cos(spiralAngle);
    const sinA = Math.sin(spiralAngle);
    const cam = ctx.camera;
    cam.position.set(
      lerpX * cosA - lerpZ * sinA,
      lerp(CAM_TOP.y, CAM_END.y, p),
      lerpX * sinA + lerpZ * cosA,
    );
    cam.lookAt(
      lerp(LOOK_TOP.x, LOOK_END.x, p),
      lerp(LOOK_TOP.y, LOOK_END.y, p),
      lerp(LOOK_TOP.z, LOOK_END.z, p),
    );

    // --- THE SIGNATURE: cross-dissolve the three maze layouts, purely from
    // progress (not dt) — scrubbing back and forth must retrace it exactly.
    const { a, b, c } = layoutWeights(clamped);
    if (hedgeMatA) hedgeMatA.opacity = a;
    if (hedgeMatB) hedgeMatB.opacity = b;
    if (hedgeMatC) hedgeMatC.opacity = c;

    // --- ambient drift: the only dt-accumulated motion ---------------------
    driftTime += dt;
    placeSpores();
    if (lanternLight) lanternLight.intensity = 1.3 + Math.sin(driftTime * 5.1) * 0.22; // lantern flicker
  }

  function setQuality(t: QualityTier): void {
    tier = t;
    applyQuality();
  }

  function dispose(): void {
    if (root && ctx) {
      ctx.scene.remove(root);
      ctx.scene.fog = null;
    }
    for (const d of disposables) d.dispose();
    disposables.length = 0;
    root = null;
    detail = null;
    hedgeA = hedgeB = hedgeC = null;
    hedgeMatA = hedgeMatB = hedgeMatC = null;
    spores = null;
    sporePositions = null;
    sporeData = [];
    lanternLight = null;
    ctx = null;
  }

  return { id: 'maze', build, update, setQuality, dispose };
}
