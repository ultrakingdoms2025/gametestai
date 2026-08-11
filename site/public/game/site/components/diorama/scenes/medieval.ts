import type * as THREE from 'three';
import type { DioramaScene, SceneCtx, QualityTier } from '../types';
import { mulberry32, smoothstep, lerp, TAU } from '@/lib/sceneMath';

/**
 * Aldermoor Vale — the exploration-world diorama (id 'medieval').
 *
 * Composition (world units, 50° fov camera at 11–28 units):
 * - a rolling ground plane (seeded sine + jitter vertex displacement,
 *   damped flat near the valley center so the town/lake sit level),
 * - a reflective lake plane (dark blue-green, glossy phong specular
 *   standing in for a real reflection),
 * - a walled town cluster: a ring of stockade-wall segments (with a gate
 *   gap) enclosing a handful of houses, each a box + pyramidal roof, with
 *   emissive amber windows,
 * - a castle silhouette on a rise: a keep + four corner towers, each
 *   topped with the same roof shape,
 * - an instanced pine forest in dark-green ranks along the valley edges,
 * - a seeded 480-point ember/pollen field drifting upward near the town,
 * - warm amber `FogExp2`, a dim blue ambient, a low warm "sunset" key
 *   light, and an amber point light over the town.
 *
 * Determinism rule: camera position/orientation derive purely from
 * `progress` (see station.ts for the reference). Only ambient drift
 * (embers rising, the town point light's flicker) accumulates via `dt`.
 * Terrain and ember layout are seeded (mulberry32) for build-to-build
 * determinism.
 */

const EMBER_COUNT = 480;
const PINE_COUNT = 50;
const HOUSE_COUNT = 6;
const WALL_SEGMENTS = 10;
const WALL_GATE_GAP = 2; // consecutive segments skipped south-facing, toward the camera's approach
const TOWER_COUNT = 4;

const TOWN_CENTER = { x: -2, z: -1 };
const TOWN_WALL_RADIUS = 4.2;
const CASTLE_CENTER = { x: -9.5, y: 1.4, z: -14 };
const LAKE_CENTER = { x: 7, z: 8.5 };

interface Ember {
  baseX: number;
  baseZ: number;
  baseY: number;
  riseSpeed: number;
  riseRange: number;
  driftRadius: number;
  phase: number;
}

export function createMedievalScene(): DioramaScene {
  // --- closure state, populated once in build() -----------------------------
  let ctx: SceneCtx | null = null;
  let root: THREE.Group | null = null;
  const disposables: Array<{ dispose(): void }> = [];

  let detail: THREE.Group | null = null; // window/beacon accents, culled on 'low'
  let embers: THREE.Points | null = null;
  let emberPositions: Float32Array | null = null;
  let emberData: Ember[] = [];
  let pines: THREE.InstancedMesh | null = null;
  let townLight: THREE.PointLight | null = null;

  let tier: QualityTier = 'high';
  // Ambient accumulators — the ONLY dt-driven state (see determinism rule).
  let driftTime = 0;

  function track<T extends { dispose(): void }>(d: T): T {
    disposables.push(d);
    return d;
  }

  function emberCount(): number {
    return tier === 'high' ? EMBER_COUNT : tier === 'medium' ? 300 : 150;
  }

  function pineCount(): number {
    return tier === 'low' ? 18 : tier === 'medium' ? 32 : PINE_COUNT;
  }

  function applyQuality(): void {
    if (!embers || !detail || !pines) return;
    embers.geometry.setDrawRange(0, emberCount());
    detail.visible = tier !== 'low';
    pines.count = pineCount();
  }

  function build(c: SceneCtx): void {
    ctx = c;
    tier = c.quality;
    const { THREE, scene, accent } = c;
    const rand = mulberry32(0xa1de_2026); // 'medieval' seed — fixed forever

    scene.fog = new THREE.FogExp2(0x2a1608, 0.028);

    root = new THREE.Group();
    scene.add(root);

    // --- lighting -------------------------------------------------------------
    root.add(new THREE.AmbientLight(0x263a55, 0.5));
    const sun = new THREE.DirectionalLight(0xffb37a, 1.15);
    sun.position.set(-10, 4.5, 6);
    root.add(sun);
    townLight = new THREE.PointLight(accent.getHex(), 1.6, 14, 2);
    townLight.position.set(TOWN_CENTER.x, 2.4, TOWN_CENTER.z);
    root.add(townLight);

    // --- shared materials -------------------------------------------------
    const groundMat = track(
      new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x140c06 }),
    );
    const lakeMat = track(
      new THREE.MeshPhongMaterial({
        color: 0x0a2c28,
        specular: 0xffcf9e,
        shininess: 130,
        emissive: 0x03110f,
      }),
    );
    const hullMat = track(
      new THREE.MeshLambertMaterial({ color: 0x8a7256, emissive: 0x140f08 }),
    );
    const roofMat = track(
      new THREE.MeshLambertMaterial({ color: 0x5c2a20, emissive: 0x110604 }),
    );
    const windowMat = track(
      new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(0.95) }),
    );
    const pineMat = track(new THREE.MeshLambertMaterial({ color: 0x0f2b1a, emissive: 0x030d07 }));
    const emberMat = track(
      new THREE.PointsMaterial({
        color: accent.getHex(),
        size: 0.16,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
      }),
    );

    // --- rolling ground plane (seeded displacement) ------------------------
    const groundGeo = track(new THREE.PlaneGeometry(60, 60, 28, 28));
    {
      const pos = groundGeo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const low = new THREE.Color(0x152616);
      const high = new THREE.Color(0x5a4a2c);
      const cTmp = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const lx = pos.getX(i);
        const ly = pos.getY(i);
        const radius = Math.hypot(lx, ly);
        const damp = smoothstep(Math.min(Math.max(radius / 9, 0), 1));
        const n =
          Math.sin(lx * 0.18 + 2.1) * 0.8 +
          Math.sin(ly * 0.14 - 0.6) * 0.6 +
          (rand() - 0.5) * 0.4;
        const height = n * damp * 1.3;
        pos.setZ(i, height);
        const t = smoothstep(Math.min(Math.max(height / 1.6 + 0.5, 0), 1));
        cTmp.copy(low).lerp(high, t);
        colors[i * 3] = cTmp.r;
        colors[i * 3 + 1] = cTmp.g;
        colors[i * 3 + 2] = cTmp.b;
      }
      groundGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      groundGeo.computeVertexNormals();
    }
    const ground = new THREE.Mesh(groundGeo, groundMat);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.35;
    root.add(ground);

    // --- lake (flat, glossy) ------------------------------------------------
    const lakeGeo = track(new THREE.PlaneGeometry(11, 7.5, 1, 1));
    const lake = new THREE.Mesh(lakeGeo, lakeMat);
    lake.rotation.x = -Math.PI / 2;
    lake.position.set(LAKE_CENTER.x, -0.28, LAKE_CENTER.z);
    root.add(lake);

    // --- shared shapes for town + castle -------------------------------------
    const boxGeo = track(new THREE.BoxGeometry(1, 1, 1));
    const roofGeo = track(new THREE.ConeGeometry(0.8, 0.75, 4));
    const towerGeo = track(new THREE.CylinderGeometry(0.5, 0.55, 3.2, 8));
    const windowGeo = track(new THREE.PlaneGeometry(0.22, 0.22));

    detail = new THREE.Group();

    // --- walled town cluster --------------------------------------------------
    const townGroup = new THREE.Group();
    const gateStart = 0; // segments [0, WALL_GATE_GAP) are skipped for the gate opening
    for (let i = 0; i < WALL_SEGMENTS; i++) {
      if (i >= gateStart && i < gateStart + WALL_GATE_GAP) continue;
      const a = (i / WALL_SEGMENTS) * TAU;
      const seg = new THREE.Mesh(boxGeo, hullMat);
      seg.scale.set(0.5, 1.5, TAU * TOWN_WALL_RADIUS / WALL_SEGMENTS + 0.05);
      seg.position.set(Math.cos(a) * TOWN_WALL_RADIUS, 0.4, Math.sin(a) * TOWN_WALL_RADIUS);
      seg.rotation.y = -a;
      townGroup.add(seg);
    }
    for (let i = 0; i < HOUSE_COUNT; i++) {
      const a = rand() * TAU;
      const r = rand() * (TOWN_WALL_RADIUS - 1.1);
      const hx = Math.cos(a) * r;
      const hz = Math.sin(a) * r;
      const w = 0.9 + rand() * 0.4;
      const d = 0.9 + rand() * 0.4;
      const h = 0.7 + rand() * 0.35;
      const house = new THREE.Mesh(boxGeo, hullMat);
      house.scale.set(w, h, d);
      house.position.set(hx, h / 2, hz);
      house.rotation.y = rand() * TAU;
      townGroup.add(house);

      const roof = new THREE.Mesh(roofGeo, roofMat);
      roof.rotation.y = Math.PI / 4;
      roof.scale.set(Math.max(w, d) * 0.85, 0.85, Math.max(w, d) * 0.85);
      roof.position.set(hx, h + 0.28, hz);
      townGroup.add(roof);

      const win = new THREE.Mesh(windowGeo, windowMat);
      win.position.set(hx + Math.sin(house.rotation.y) * (w / 2 + 0.01), h * 0.55, hz + Math.cos(house.rotation.y) * (w / 2 + 0.01));
      win.rotation.y = house.rotation.y;
      detail.add(win);
    }
    root.add(townGroup);
    townGroup.position.set(TOWN_CENTER.x, 0, TOWN_CENTER.z);

    // --- castle on a rise -------------------------------------------------
    const castleGroup = new THREE.Group();
    const keep = new THREE.Mesh(boxGeo, hullMat);
    keep.scale.set(2.3, 2.8, 2.3);
    keep.position.set(0, 1.4, 0);
    castleGroup.add(keep);
    const keepRoof = new THREE.Mesh(roofGeo, roofMat);
    keepRoof.rotation.y = Math.PI / 4;
    keepRoof.scale.set(1.9, 1.3, 1.9);
    keepRoof.position.set(0, 3.35, 0);
    castleGroup.add(keepRoof);

    for (let i = 0; i < TOWER_COUNT; i++) {
      const a = (i / TOWER_COUNT) * TAU + Math.PI / 4;
      const tx = Math.cos(a) * 1.9;
      const tz = Math.sin(a) * 1.9;
      const tower = new THREE.Mesh(towerGeo, hullMat);
      tower.position.set(tx, 1.6, tz);
      castleGroup.add(tower);
      const towerRoof = new THREE.Mesh(roofGeo, roofMat);
      towerRoof.scale.set(0.85, 1.15, 0.85);
      towerRoof.position.set(tx, 3.45, tz);
      castleGroup.add(towerRoof);
      const beacon = new THREE.Mesh(windowGeo, windowMat);
      beacon.position.set(tx, 2.6, tz + 0.56);
      detail.add(beacon);
    }
    castleGroup.position.set(CASTLE_CENTER.x, CASTLE_CENTER.y, CASTLE_CENTER.z);
    root.add(castleGroup);
    root.add(detail);

    // --- pine forest (instanced, valley edges) -------------------------------
    const pineGeo = track(new THREE.ConeGeometry(0.45, 1.8, 6));
    pines = new THREE.InstancedMesh(pineGeo, pineMat, PINE_COUNT);
    const m = new THREE.Matrix4();
    for (let i = 0; i < PINE_COUNT; i++) {
      // Two loose bands: one ringing the castle rise, one along the far tree line.
      const band = i % 2 === 0 ? 0 : 1;
      const a = rand() * TAU;
      const r = band === 0 ? 6 + rand() * 3 : 16 + rand() * 8;
      const px = CASTLE_CENTER.x * 0.4 + Math.cos(a) * r;
      const pz = CASTLE_CENTER.z * 0.4 + Math.sin(a) * r;
      const s = 0.7 + rand() * 0.7;
      m.makeScale(s, s, s);
      m.setPosition(px, 0.55 * s, pz);
      pines.setMatrixAt(i, m);
    }
    pines.instanceMatrix.needsUpdate = true;
    root.add(pines);

    // --- embers / pollen (seeded, drifting upward near the town) -----------
    emberData = [];
    for (let i = 0; i < EMBER_COUNT; i++) {
      emberData.push({
        baseX: TOWN_CENTER.x + (rand() - 0.5) * 14,
        baseZ: TOWN_CENTER.z + (rand() - 0.5) * 14,
        baseY: rand() * 0.6,
        riseSpeed: 0.15 + rand() * 0.25,
        riseRange: 3 + rand() * 2,
        driftRadius: rand() * 0.6,
        phase: rand() * TAU,
      });
    }
    emberPositions = new Float32Array(EMBER_COUNT * 3);
    const emberGeo = track(new THREE.BufferGeometry());
    const emberAttr = new THREE.BufferAttribute(emberPositions, 3);
    emberAttr.setUsage(THREE.DynamicDrawUsage); // rewritten every frame in placeEmbers()
    emberGeo.setAttribute('position', emberAttr);
    embers = new THREE.Points(emberGeo, emberMat);
    embers.frustumCulled = false; // positions mutate every frame; skip stale-bounds culling
    root.add(embers);
    placeEmbers(); // lay out at t=0 so the first frame isn't a clump at origin

    applyQuality();
  }

  function placeEmbers(): void {
    if (!embers || !emberPositions) return;
    const n = emberCount();
    for (let i = 0; i < n; i++) {
      const e = emberData[i];
      const riseT = ((driftTime * e.riseSpeed + e.phase) % e.riseRange) / e.riseRange;
      emberPositions[i * 3] = e.baseX + Math.sin(driftTime * 0.3 + e.phase) * e.driftRadius;
      emberPositions[i * 3 + 1] = e.baseY + riseT * e.riseRange;
      emberPositions[i * 3 + 2] = e.baseZ + Math.cos(driftTime * 0.27 + e.phase) * e.driftRadius;
    }
    (embers.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  function update(dt: number, progress: number, active: boolean): void {
    if (!active) return;
    if (!ctx || !root) return; // not built yet — DioramaCanvas never does this, but stay safe

    // --- camera: pure function of progress ---------------------------------
    // Start high and wide over the whole valley (lake + town + castle in
    // frame); descend and glide toward the town gates as progress -> 1,
    // the look target drifting from the valley center to the gate.
    const p = smoothstep(Math.min(Math.max(progress, 0), 1));
    const cam = ctx.camera;
    const camX = lerp(-2, TOWN_CENTER.x + 1.5, p) + Math.sin(p * Math.PI) * 2.2;
    const camY = lerp(15.5, 4.3, p);
    const camZ = lerp(23, TOWN_CENTER.z + 7, p);
    cam.position.set(camX, camY, camZ);
    const lookX = lerp(2, TOWN_CENTER.x, p);
    const lookY = lerp(1, 1.6, p);
    const lookZ = lerp(0, TOWN_CENTER.z - 1, p);
    cam.lookAt(lookX, lookY, lookZ);

    // --- ambient drift: the only dt-accumulated motion ---------------------
    driftTime += dt;
    if (townLight) townLight.intensity = 1.6 + Math.sin(driftTime * 4.2) * 0.15; // hearth-fire flicker
    placeEmbers();
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
    embers = null;
    emberPositions = null;
    emberData = [];
    pines = null;
    townLight = null;
    ctx = null;
  }

  return { id: 'medieval', build, update, setQuality, dispose };
}
