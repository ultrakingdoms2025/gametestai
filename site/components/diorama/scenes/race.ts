import type * as THREE from 'three';
import type { DioramaScene, SceneCtx, QualityTier } from '../types';
import { mulberry32, smoothstep, lerp, TAU } from '@/lib/sceneMath';

/**
 * Vellum Ridge — the competition-world diorama (id 'race').
 *
 * Composition (world units, 50° fov camera at ~2–22 units):
 * - a rolling terrain base: a seeded-displaced plane with a dark
 *   rock-to-rust vertex-color gradient,
 * - a CLOSED-LOOP elevated track ribbon built from a closed
 *   CatmullRomCurve3 (10 control points varying in x/z AND y — climbs and
 *   dives), sampled at 120 points into a hand-built triangle ribbon: dark
 *   asphalt plus a thinner, accent-tinted emissive center line,
 * - support pylons: a shared thin cylinder repeated under the ribbon at
 *   intervals, each scaled from the ribbon's height down to the ground,
 * - a city-block cluster inside the loop: a shared box silhouette with
 *   sparse warm emissive windows,
 * - a start/finish gantry at the track's t=0 point: two posts, a
 *   crossbeam, and a row of alternating emissive squares as a checker hint,
 * - THE SIGNATURE: a car (`.name = 'car'`) that advances along the same
 *   closed curve every frame via `dt`, oriented to face its direction of
 *   travel, with a bright accent body, a white glow shell, and a faint red
 *   taillight point light,
 * - a seeded, ≤500-point spark/dust field drifting through the scene,
 * - deep red-orange dusk `FogExp2`, dim warm ambient, a low red-orange
 *   directional "sunset" key light, and an accent point light at the
 *   start/finish gantry.
 *
 * Determinism rule: camera position/orientation derive purely from
 * `progress` (see station.ts for the reference) — the two fixed camera
 * endpoints are themselves derived once at build time from the seeded
 * track curve, so they never vary between builds. Only ambient drift (the
 * car's advance along the curve, spark drift, light flicker) accumulates
 * via `dt`. Track shape and spark layout are seeded (mulberry32) for
 * build-to-build determinism.
 */

const RIBBON_SAMPLES = 120;
const LOOP_CONTROL_COUNT = 10;
const PYLON_INTERVAL = 8; // every 8th sample gets a support pylon (15 total)
const SPARK_COUNT = 500;
const CITY_COUNT = 14;
const CHECKER_COUNT = 6;
const RIBBON_HALF_WIDTH = 0.45; // ~0.9 units wide
const CAR_LIFT = 0.14; // car rides slightly above the ribbon surface
const CAR_LOOP_SECONDS = 9; // one lap every 9s of ambient drift time

interface Spark {
  baseX: number;
  baseY: number;
  baseZ: number;
  driftSpeed: number;
  driftRange: number;
  phase: number;
}

const CAM_START_POS = { x: 1.1, y: 22, z: 0.9 };
const CAM_START_LOOK = { x: 0, y: 1.4, z: 0 };

export function createRaceScene(): DioramaScene {
  // --- closure state, populated once in build() -----------------------------
  let ctx: SceneCtx | null = null;
  let root: THREE.Group | null = null;
  const disposables: Array<{ dispose(): void }> = [];

  let detail: THREE.Group | null = null; // city windows + gantry checkers — culled on 'low'
  let car: THREE.Group | null = null;
  let sparks: THREE.Points | null = null;
  let sparkPositions: Float32Array | null = null;
  let sparkData: Spark[] = [];
  let gantryLight: THREE.PointLight | null = null;
  let taillight: THREE.PointLight | null = null;
  let trackCurve: THREE.CatmullRomCurve3 | null = null;

  // Preallocated scratch vectors reused every frame so the car's per-frame
  // pathing performs zero allocations (see the performance note in the task).
  let carPos: THREE.Vector3 | null = null;
  let carLookPos: THREE.Vector3 | null = null;

  // Camera endpoints, derived once from the seeded curve at build time —
  // update() only ever lerps between these two fixed points, so the camera
  // stays a pure function of `progress`.
  let camEndPos = { x: 0, y: 0, z: 0 };
  let camEndLook = { x: 0, y: 0, z: 0 };

  let tier: QualityTier = 'high';
  // Ambient accumulators — the ONLY dt-driven state (see determinism rule).
  let driftTime = 0;
  let carT = 0;

  function track<T extends { dispose(): void }>(d: T): T {
    disposables.push(d);
    return d;
  }

  function sparkCount(): number {
    return tier === 'high' ? SPARK_COUNT : tier === 'medium' ? 300 : 150;
  }

  function applyQuality(): void {
    if (!sparks || !detail) return;
    sparks.geometry.setDrawRange(0, sparkCount());
    detail.visible = tier !== 'low';
  }

  function build(c: SceneCtx): void {
    ctx = c;
    tier = c.quality;
    const { THREE, scene, accent } = c;
    const rand = mulberry32(0x5261_6365); // 'Race' seed — fixed forever

    scene.fog = new THREE.FogExp2(0x2a0f08, 0.026);

    root = new THREE.Group();
    scene.add(root);
    detail = new THREE.Group();

    // --- lighting -------------------------------------------------------------
    root.add(new THREE.AmbientLight(0x3a2015, 0.5));
    const sun = new THREE.DirectionalLight(0xff7a4a, 0.95);
    sun.position.set(-8, 1.9, 4.5); // low, red-orange dusk key light
    root.add(sun);

    // --- shared materials -------------------------------------------------
    const terrainMat = track(
      new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x0c0704 }),
    );
    const asphaltMat = track(
      new THREE.MeshLambertMaterial({
        color: 0x1c1a1c,
        emissive: 0x0a0908,
        side: THREE.DoubleSide,
      }),
    );
    const centerLineMat = track(
      new THREE.MeshBasicMaterial({
        color: accent.getHex(),
        transparent: true,
        opacity: 0.85,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const steelMat = track(
      new THREE.MeshLambertMaterial({ color: 0x2c2a30, emissive: 0x08070a }),
    );
    const buildingMat = track(
      new THREE.MeshLambertMaterial({ color: 0x14110f, emissive: 0x050403 }),
    );
    const windowMat = track(
      new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(0.9) }),
    );
    const checkerMatA = track(new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const checkerMatB = track(new THREE.MeshBasicMaterial({ color: accent.getHex() }));
    const carMat = track(new THREE.MeshBasicMaterial({ color: accent.getHex() }));
    const carGlowMat = track(
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
      }),
    );
    const sparkMat = track(
      new THREE.PointsMaterial({
        color: 0xffb060,
        size: 0.07,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
      }),
    );

    // --- rolling terrain base (seeded displacement, rock→rust gradient) -----
    const terrainGeo = track(new THREE.PlaneGeometry(46, 46, 28, 28));
    {
      const pos = terrainGeo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const lo = new THREE.Color(0x1c130d); // shadowed rock
      const hi = new THREE.Color(0x5c2c18); // sun-caught rust
      const cTmp = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const h = (rand() - 0.5) * 1.1;
        pos.setZ(i, h); // local Z becomes world Y once rotated flat below
        const t = smoothstep(Math.min(Math.max(h / 1.1 + 0.5, 0), 1));
        cTmp.copy(lo).lerp(hi, t);
        colors[i * 3] = cTmp.r;
        colors[i * 3 + 1] = cTmp.g;
        colors[i * 3 + 2] = cTmp.b;
      }
      terrainGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      terrainGeo.computeVertexNormals();
    }
    const terrain = new THREE.Mesh(terrainGeo, terrainMat);
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.y = -0.15;
    root.add(terrain);

    // --- closed-loop track curve: 10 control points, x/z AND y vary ---------
    const controlPoints: THREE.Vector3[] = [];
    for (let i = 0; i < LOOP_CONTROL_COUNT; i++) {
      const a = (i / LOOP_CONTROL_COUNT) * TAU;
      const radius = 7.6 + rand() * 3.2 + Math.sin(a * 2) * 1.1;
      const x = Math.cos(a) * radius;
      const z = Math.sin(a) * radius;
      const y = Math.max(2.3 + Math.sin(a * 2.3 + 1.1) * 1.5 + (rand() - 0.5) * 0.6, 0.6);
      controlPoints.push(new THREE.Vector3(x, y, z));
    }
    trackCurve = new THREE.CatmullRomCurve3(controlPoints, true, 'catmullrom', 0.5);
    const curve = trackCurve;

    // --- track ribbon: sample the curve, build a two-vertex-per-sample strip -
    const tangentTmp = new THREE.Vector3();
    const perpTmp = new THREE.Vector3();
    function perpAt(t: number): THREE.Vector3 {
      curve.getTangentAt(t, tangentTmp);
      perpTmp.set(-tangentTmp.z, 0, tangentTmp.x);
      if (perpTmp.lengthSq() < 1e-8) perpTmp.set(1, 0, 0);
      return perpTmp.normalize();
    }
    function buildRibbonGeometry(halfWidth: number, yOffset: number): THREE.BufferGeometry {
      const positions = new Float32Array(RIBBON_SAMPLES * 2 * 3);
      const pt = new THREE.Vector3();
      for (let i = 0; i < RIBBON_SAMPLES; i++) {
        const t = i / RIBBON_SAMPLES;
        curve.getPointAt(t, pt);
        const perp = perpAt(t);
        const y = pt.y + yOffset;
        positions[i * 6] = pt.x + perp.x * halfWidth;
        positions[i * 6 + 1] = y;
        positions[i * 6 + 2] = pt.z + perp.z * halfWidth;
        positions[i * 6 + 3] = pt.x - perp.x * halfWidth;
        positions[i * 6 + 4] = y;
        positions[i * 6 + 5] = pt.z - perp.z * halfWidth;
      }
      const indices: number[] = [];
      for (let i = 0; i < RIBBON_SAMPLES; i++) {
        const next = (i + 1) % RIBBON_SAMPLES;
        const va = i * 2;
        const vb = i * 2 + 1;
        const vc = next * 2;
        const vd = next * 2 + 1;
        indices.push(va, vb, vc, vb, vd, vc);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setIndex(indices);
      geo.computeVertexNormals();
      return geo;
    }
    const ribbonGeo = track(buildRibbonGeometry(RIBBON_HALF_WIDTH, 0));
    const centerLineGeo = track(buildRibbonGeometry(0.05, 0.015));
    root.add(new THREE.Mesh(ribbonGeo, asphaltMat));
    root.add(new THREE.Mesh(centerLineGeo, centerLineMat));

    // --- support pylons (shared cylinder, repeated at intervals) ------------
    const pylonGeo = track(new THREE.CylinderGeometry(0.07, 0.09, 1, 8));
    const pylonPt = new THREE.Vector3();
    for (let i = 0; i < RIBBON_SAMPLES; i += PYLON_INTERVAL) {
      const t = i / RIBBON_SAMPLES;
      curve.getPointAt(t, pylonPt);
      const h = Math.max(pylonPt.y - 0.05, 0.15);
      const pylon = new THREE.Mesh(pylonGeo, steelMat);
      pylon.scale.set(1, h, 1);
      pylon.position.set(pylonPt.x, h / 2, pylonPt.z);
      root.add(pylon);
    }

    // --- start/finish gantry at the curve's t=0 point ------------------------
    const gantryPoint = new THREE.Vector3();
    curve.getPointAt(0, gantryPoint);
    const gantryTangent = new THREE.Vector3();
    curve.getTangentAt(0, gantryTangent);
    const tangentHoriz = new THREE.Vector3(gantryTangent.x, 0, gantryTangent.z).normalize();
    const gantryPerp = new THREE.Vector3(-tangentHoriz.z, 0, tangentHoriz.x).normalize();
    const postOffset = 0.62;
    const postHeight = gantryPoint.y + 1.5;

    const post1 = new THREE.Mesh(pylonGeo, steelMat);
    post1.scale.set(1.3, postHeight, 1.3);
    post1.position.set(
      gantryPoint.x + gantryPerp.x * postOffset,
      postHeight / 2,
      gantryPoint.z + gantryPerp.z * postOffset,
    );
    root.add(post1);
    const post2 = new THREE.Mesh(pylonGeo, steelMat);
    post2.scale.set(1.3, postHeight, 1.3);
    post2.position.set(
      gantryPoint.x - gantryPerp.x * postOffset,
      postHeight / 2,
      gantryPoint.z - gantryPerp.z * postOffset,
    );
    root.add(post2);

    const crossbeamGeo = track(new THREE.BoxGeometry(1, 1, 1));
    const crossbeam = new THREE.Mesh(crossbeamGeo, steelMat);
    crossbeam.scale.set(0.14, 0.14, postOffset * 2 + 0.3);
    crossbeam.rotation.y = Math.atan2(gantryPerp.x, gantryPerp.z);
    crossbeam.position.set(gantryPoint.x, postHeight, gantryPoint.z);
    root.add(crossbeam);

    const checkerGeo = track(new THREE.PlaneGeometry(0.18, 0.18));
    for (let i = 0; i < CHECKER_COUNT; i++) {
      const tt = (i + 0.5) / CHECKER_COUNT - 0.5; // -0.5..0.5 across the beam
      const checker = new THREE.Mesh(checkerGeo, i % 2 === 0 ? checkerMatA : checkerMatB);
      checker.position.set(
        gantryPoint.x + gantryPerp.x * tt * (postOffset * 2),
        postHeight - 0.14,
        gantryPoint.z + gantryPerp.z * tt * (postOffset * 2),
      );
      checker.rotation.y = Math.atan2(tangentHoriz.x, tangentHoriz.z);
      detail.add(checker);
    }

    gantryLight = new THREE.PointLight(accent.getHex(), 1.6, 15, 2);
    gantryLight.position.set(gantryPoint.x, postHeight - 0.4, gantryPoint.z);
    root.add(gantryLight);

    // --- city-block cluster inside the loop -----------------------------------
    const buildingGeo = track(new THREE.BoxGeometry(1, 1, 1));
    const windowGeo = track(new THREE.PlaneGeometry(0.1, 0.14));
    const cityCenter = { x: -2.4, z: -1.1 };
    for (let i = 0; i < CITY_COUNT; i++) {
      const bx = cityCenter.x + (rand() - 0.5) * 5.4;
      const bz = cityCenter.z + (rand() - 0.5) * 5.4;
      const w = 0.5 + rand() * 0.5;
      const d = 0.5 + rand() * 0.5;
      const h = 0.6 + rand() * 1.8;
      const building = new THREE.Mesh(buildingGeo, buildingMat);
      building.scale.set(w, h, d);
      building.position.set(bx, h / 2, bz);
      root.add(building);
      if (rand() > 0.5) {
        const win = new THREE.Mesh(windowGeo, windowMat);
        win.position.set(bx, h * 0.6, bz + d / 2 + 0.01);
        detail.add(win);
      }
    }

    // --- THE SIGNATURE: the car, advancing along the same closed curve -------
    const carBodyGeo = track(new THREE.BoxGeometry(0.34, 0.16, 0.9));
    const carCabinGeo = track(new THREE.CylinderGeometry(0.02, 0.16, 0.5, 3));
    const carGlowGeo = track(new THREE.BoxGeometry(0.5, 0.3, 1.05));

    car = new THREE.Group();
    car.name = 'car';
    const carBody = new THREE.Mesh(carBodyGeo, carMat);
    carBody.position.y = 0.1;
    car.add(carBody);
    const carCabin = new THREE.Mesh(carCabinGeo, carMat);
    carCabin.rotation.x = Math.PI / 2;
    carCabin.position.set(0, 0.22, -0.08);
    car.add(carCabin);
    const carGlow = new THREE.Mesh(carGlowGeo, carGlowMat);
    carGlow.position.y = 0.16;
    car.add(carGlow);
    taillight = new THREE.PointLight(0xff2211, 0.8, 3.2, 2);
    taillight.position.set(0, 0.12, 0.42);
    car.add(taillight);
    root.add(car);

    carPos = new THREE.Vector3();
    carLookPos = new THREE.Vector3();
    placeCar(); // lay out at t=0 so the first frame isn't a jump from the origin

    // --- camera endpoints, derived once from the seeded curve ---------------
    camEndPos = {
      x: gantryPoint.x - tangentHoriz.x * 3.4,
      y: gantryPoint.y + 1.3,
      z: gantryPoint.z - tangentHoriz.z * 3.4,
    };
    camEndLook = {
      x: gantryPoint.x + tangentHoriz.x * 5,
      y: gantryPoint.y + 0.4,
      z: gantryPoint.z + tangentHoriz.z * 5,
    };

    // --- spark/dust field (seeded, drifting through the whole scene) --------
    sparkData = [];
    for (let i = 0; i < SPARK_COUNT; i++) {
      sparkData.push({
        baseX: (rand() - 0.5) * 26,
        baseY: rand() * 5.5,
        baseZ: (rand() - 0.5) * 26,
        driftSpeed: 0.05 + rand() * 0.09,
        driftRange: 0.6 + rand() * 1.2,
        phase: rand() * TAU,
      });
    }
    sparkPositions = new Float32Array(SPARK_COUNT * 3);
    const sparkGeo = track(new THREE.BufferGeometry());
    const sparkAttr = new THREE.BufferAttribute(sparkPositions, 3);
    sparkAttr.setUsage(THREE.DynamicDrawUsage); // rewritten every frame in placeSparks()
    sparkGeo.setAttribute('position', sparkAttr);
    sparks = new THREE.Points(sparkGeo, sparkMat);
    sparks.frustumCulled = false; // positions mutate every frame; skip stale-bounds culling
    root.add(sparks);
    placeSparks(); // lay out at t=0 so the first frame isn't a clump at origin

    root.add(detail);
    applyQuality();
  }

  function placeCar(): void {
    if (!car || !trackCurve || !carPos || !carLookPos) return;
    trackCurve.getPointAt(carT, carPos);
    car.position.set(carPos.x, carPos.y + CAR_LIFT, carPos.z);
    const aheadT = (carT + 0.01) % 1;
    trackCurve.getPointAt(aheadT, carLookPos);
    carLookPos.y += CAR_LIFT;
    car.lookAt(carLookPos);
  }

  function placeSparks(): void {
    if (!sparks || !sparkPositions) return;
    const n = sparkCount();
    for (let i = 0; i < n; i++) {
      const s = sparkData[i];
      sparkPositions[i * 3] = s.baseX + Math.sin(driftTime * s.driftSpeed + s.phase) * s.driftRange;
      sparkPositions[i * 3 + 1] = s.baseY + Math.sin(driftTime * 0.3 + s.phase) * 0.2;
      sparkPositions[i * 3 + 2] =
        s.baseZ + Math.cos(driftTime * s.driftSpeed * 0.8 + s.phase) * s.driftRange;
    }
    (sparks.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  function update(dt: number, progress: number, active: boolean): void {
    if (!active) return;
    if (!ctx || !root) return; // not built yet — DioramaCanvas never does this, but stay safe

    // --- camera: pure function of progress ---------------------------------
    // Start high above the circuit seeing the whole loop shape; descend and
    // bank ~45° following the general track direction; end low near the
    // start/finish gantry looking down the main straight.
    const p = smoothstep(Math.min(Math.max(progress, 0), 1));
    const bx = lerp(CAM_START_POS.x, camEndPos.x, p);
    const by = lerp(CAM_START_POS.y, camEndPos.y, p);
    const bz = lerp(CAM_START_POS.z, camEndPos.z, p);
    const bank = p * (Math.PI / 4);
    const cosB = Math.cos(bank);
    const sinB = Math.sin(bank);
    const cam = ctx.camera;
    cam.position.set(bx * cosB - bz * sinB, by, bx * sinB + bz * cosB);
    cam.lookAt(
      lerp(CAM_START_LOOK.x, camEndLook.x, p),
      lerp(CAM_START_LOOK.y, camEndLook.y, p),
      lerp(CAM_START_LOOK.z, camEndLook.z, p),
    );

    // --- ambient drift: the only dt-accumulated motion ---------------------
    driftTime += dt;
    carT += dt / CAR_LOOP_SECONDS;
    carT -= Math.floor(carT); // wrap into [0, 1)
    placeCar();
    placeSparks();
    if (gantryLight) gantryLight.intensity = 1.6 + Math.sin(driftTime * 4.4) * 0.18;
    if (taillight) taillight.intensity = 0.8 + Math.sin(driftTime * 9) * 0.15;
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
    car = null;
    sparks = null;
    sparkPositions = null;
    sparkData = [];
    gantryLight = null;
    taillight = null;
    trackCurve = null;
    carPos = null;
    carLookPos = null;
    ctx = null;
  }

  return { id: 'race', build, update, setQuality, dispose };
}
