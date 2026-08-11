import type * as THREE from 'three';
import type { DioramaScene, SceneCtx, QualityTier } from '../types';
import { mulberry32, smoothstep, lerp, TAU } from '@/lib/sceneMath';

/**
 * Sunspire Citadel — the vertical world diorama (id 'citadel').
 *
 * Composition (world units, 50° fov camera at ~4–9 units):
 * - a cliff mesa at the base: a single tapered cylinder with a vertex-color
 *   gradient darkening from sandstone at the rim down to shadowed rock at
 *   the foot,
 * - a terraced town climbing it: four rings of flat-roofed sandstone houses
 *   (shared box geometry) shrinking in radius as they rise, each with a
 *   warm emissive window and, here and there, a souk awning hint,
 * - two rope bridges (small sagging planks) linking adjacent terrace rings,
 * - four minarets (thin tapered shafts topped with a squashed "onion" bulb
 *   + spike) planted among the middle terraces,
 * - THE GREAT TOWER at the summit — the same shared shaft geometry scaled
 *   up, topped with a glowing beacon (bright core + additive glow shell)
 *   and its own accent point light,
 * - a seeded, ≤700-point dust-mote field drifting slowly sideways through
 *   the whole scene,
 * - warm dusty `FogExp2`, amber ambient, a fixed low "golden hour" sun, and
 *   the signature move: a warm spot light whose *target* climbs the great
 *   tower's shaft as `progress` advances, so the lit band visibly rises.
 *
 * Determinism rule: camera position/orientation and the rake spotlight's
 * target height derive purely from `progress` (see station.ts for the
 * reference). Only ambient drift (dust drift, beacon flicker) accumulates
 * via `dt`. Terrace/minaret/dust layout is seeded (mulberry32) for
 * build-to-build determinism.
 */

const DUST_COUNT = 700;
const HOUSES_PER_LEVEL = [6, 6, 5, 4] as const;
const TERRACE_LEVELS = [3.3, 4.4, 5.5, 6.6] as const;
const TERRACE_RADII: readonly [number, number][] = [
  [2.6, 3.4],
  [2.0, 2.7],
  [1.4, 2.0],
  [0.9, 1.4],
];
const MINARET_COUNT = 4;
const TOWER_BASE_Y = TERRACE_LEVELS[TERRACE_LEVELS.length - 1];
const TOWER_HEIGHT = 3.0;
const TOWER_TOP_Y = TOWER_BASE_Y + TOWER_HEIGHT;

interface Mote {
  baseX: number;
  baseY: number;
  baseZ: number;
  driftSpeed: number;
  driftRange: number;
  phase: number;
}

export function createCitadelScene(): DioramaScene {
  // --- closure state, populated once in build() -----------------------------
  let ctx: SceneCtx | null = null;
  let root: THREE.Group | null = null;
  const disposables: Array<{ dispose(): void }> = [];

  let detail: THREE.Group | null = null; // windows, awnings, onion tips, bridges — culled on 'low'
  let dust: THREE.Points | null = null;
  let dustPositions: Float32Array | null = null;
  let moteData: Mote[] = [];
  let beaconLight: THREE.PointLight | null = null;
  let rakeLight: THREE.SpotLight | null = null;
  let rakeTarget: THREE.Object3D | null = null;

  let tier: QualityTier = 'high';
  // Ambient accumulators — the ONLY dt-driven state (see determinism rule).
  let driftTime = 0;

  function track<T extends { dispose(): void }>(d: T): T {
    disposables.push(d);
    return d;
  }

  function dustCount(): number {
    return tier === 'high' ? DUST_COUNT : tier === 'medium' ? 400 : 200;
  }

  function applyQuality(): void {
    if (!dust || !detail) return;
    dust.geometry.setDrawRange(0, dustCount());
    detail.visible = tier !== 'low';
  }

  function build(c: SceneCtx): void {
    ctx = c;
    tier = c.quality;
    const { THREE, scene, accent } = c;
    const rand = mulberry32(0x4369_7461); // 'cita' seed — fixed forever

    scene.fog = new THREE.FogExp2(0x3b2a22, 0.024);

    root = new THREE.Group();
    scene.add(root);
    detail = new THREE.Group();

    // --- lighting ---------------------------------------------------------
    root.add(new THREE.AmbientLight(0x4a3020, 0.55));
    const sun = new THREE.DirectionalLight(0xffb877, 1.1);
    sun.position.set(-9, 2.4, 5.5); // low, warm — golden-hour key light
    root.add(sun);

    // Signature move: a warm spot light whose target climbs the great
    // tower's shaft as progress advances (see update()), so the lit band
    // visibly rises up the tower on scroll.
    rakeLight = new THREE.SpotLight(accent.getHex(), 3.2, 18, 0.4, 0.65, 1.4);
    rakeLight.position.set(3.4, 1.0, 2.6);
    rakeTarget = new THREE.Object3D();
    rakeTarget.position.set(0, TOWER_BASE_Y, 0);
    root.add(rakeTarget);
    rakeLight.target = rakeTarget;
    root.add(rakeLight);

    // --- shared materials ---------------------------------------------------
    const houseMat = track(
      new THREE.MeshLambertMaterial({ color: 0xc2a184, emissive: 0x1c1108 }),
    );
    const roofMat = track(
      new THREE.MeshLambertMaterial({ color: 0xdccaa8, emissive: 0x1c1108 }),
    );
    const windowMat = track(
      new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(0.95) }),
    );
    const awningMatA = track(new THREE.MeshBasicMaterial({ color: 0x9c3b32, side: THREE.DoubleSide }));
    const awningMatB = track(new THREE.MeshBasicMaterial({ color: 0x2f6e78, side: THREE.DoubleSide }));
    const shaftMat = track(
      new THREE.MeshLambertMaterial({ color: 0xe4d3ae, emissive: 0x201607 }),
    );
    const onionMat = track(
      new THREE.MeshLambertMaterial({ color: 0xb87f3a, emissive: 0x1c0f04 }),
    );
    const beaconMat = track(new THREE.MeshBasicMaterial({ color: accent.getHex() }));
    const beaconGlowMat = track(
      new THREE.MeshBasicMaterial({
        color: accent.getHex(),
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
      }),
    );
    const bridgeMat = track(
      new THREE.MeshLambertMaterial({ color: 0x4a3524, emissive: 0x0c0803 }),
    );
    const dustMat = track(
      new THREE.PointsMaterial({
        color: 0xf3dfa8,
        size: 0.075,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.6,
        depthWrite: false,
      }),
    );

    // --- shared geometries ---------------------------------------------------
    const boxGeo = track(new THREE.BoxGeometry(1, 1, 1));
    const awningGeo = track(new THREE.PlaneGeometry(0.5, 0.34));
    const windowGeo = track(new THREE.PlaneGeometry(0.12, 0.12));
    // Unit-height tapered cylinder reused for both minaret shafts and the
    // great tower's shaft, just scaled very differently.
    const shaftGeo = track(new THREE.CylinderGeometry(0.4, 0.55, 1, 8));
    const onionSphereGeo = track(new THREE.SphereGeometry(0.5, 8, 6));
    const onionSpikeGeo = track(new THREE.ConeGeometry(0.15, 0.4, 6));
    const beaconCoreGeo = track(new THREE.SphereGeometry(0.35, 12, 8));
    const beaconGlowGeo = track(new THREE.SphereGeometry(0.55, 12, 8));

    // --- cliff mesa (tapered, vertex-colored gradient) -----------------------
    const cliffGeo = track(new THREE.CylinderGeometry(2.3, 4.6, 6, 12, 6));
    {
      const pos = cliffGeo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const lo = new THREE.Color(0x2f2016); // shadowed rock, base
      const hi = new THREE.Color(0xd8bb99); // sunlit sandstone, rim
      const cTmp = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const t = smoothstep(Math.min(Math.max(pos.getY(i) / 6 + 0.5, 0), 1));
        cTmp.copy(lo).lerp(hi, t);
        colors[i * 3] = cTmp.r;
        colors[i * 3 + 1] = cTmp.g;
        colors[i * 3 + 2] = cTmp.b;
      }
      cliffGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    const cliffMat = track(
      new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x0e0a06 }),
    );
    const cliff = new THREE.Mesh(cliffGeo, cliffMat);
    root.add(cliff);

    // --- terraced town: 4 rings of houses climbing the cliff -----------------
    // Anchors recorded per level so rope bridges can span between them below.
    const levelAnchors: { x: number; y: number; z: number }[] = [];
    for (let lvl = 0; lvl < TERRACE_LEVELS.length; lvl++) {
      const y = TERRACE_LEVELS[lvl];
      const [rInner, rOuter] = TERRACE_RADII[lvl];
      const count = HOUSES_PER_LEVEL[lvl];
      let anchorAngle = 0;
      for (let i = 0; i < count; i++) {
        const a = (i / count) * TAU + rand() * 0.4;
        if (i === 0) anchorAngle = a;
        const r = rInner + rand() * (rOuter - rInner);
        const hx = Math.cos(a) * r;
        const hz = Math.sin(a) * r;
        const w = 0.55 + rand() * 0.25;
        const d = 0.55 + rand() * 0.25;
        const h = 0.4 + rand() * 0.22;

        const house = new THREE.Mesh(boxGeo, houseMat);
        house.scale.set(w, h, d);
        house.position.set(hx, y + h / 2, hz);
        house.rotation.y = a;
        root.add(house);

        const roof = new THREE.Mesh(boxGeo, roofMat);
        roof.scale.set(w * 1.06, 0.05, d * 1.06);
        roof.position.set(hx, y + h + 0.03, hz);
        roof.rotation.y = a;
        root.add(roof);

        const win = new THREE.Mesh(windowGeo, windowMat);
        win.position.set(
          hx + Math.sin(a) * (w / 2 + 0.01),
          y + h * 0.55,
          hz + Math.cos(a) * (w / 2 + 0.01),
        );
        win.rotation.y = a;
        detail.add(win);

        if (rand() > 0.55) {
          const awning = new THREE.Mesh(awningGeo, rand() > 0.5 ? awningMatA : awningMatB);
          awning.position.set(
            hx + Math.sin(a) * (w / 2 + 0.02),
            y + h * 0.28,
            hz + Math.cos(a) * (w / 2 + 0.02),
          );
          awning.rotation.y = a;
          awning.rotation.x = -0.35;
          detail.add(awning);
        }
      }
      levelAnchors.push({
        x: Math.cos(anchorAngle) * (rInner + rOuter) * 0.5,
        y,
        z: Math.sin(anchorAngle) * (rInner + rOuter) * 0.5,
      });
    }

    // --- rope bridges: sagging plank rows between adjacent terrace levels ----
    function addBridge(
      p0: { x: number; y: number; z: number },
      p1: { x: number; y: number; z: number },
      plankCount: number,
      sag: number,
    ): void {
      if (!detail) return;
      const dx = p1.x - p0.x;
      const dz = p1.z - p0.z;
      const angle = Math.atan2(dx, dz);
      const len = Math.hypot(dx, dz) / plankCount;
      for (let i = 0; i < plankCount; i++) {
        const t = (i + 0.5) / plankCount;
        const plank = new THREE.Mesh(boxGeo, bridgeMat);
        plank.scale.set(0.22, 0.045, len * 0.94);
        plank.position.set(
          lerp(p0.x, p1.x, t),
          lerp(p0.y, p1.y, t) - Math.sin(Math.PI * t) * sag,
          lerp(p0.z, p1.z, t),
        );
        plank.rotation.y = angle;
        detail.add(plank);
      }
    }
    addBridge(levelAnchors[0], levelAnchors[1], 9, 0.22);
    addBridge(levelAnchors[1], levelAnchors[2], 7, 0.18);

    // --- minarets: thin tapered shafts + squashed onion bulb + spike ---------
    for (let i = 0; i < MINARET_COUNT; i++) {
      const lvl = 1 + (i % 2); // levels 1 and 2
      const [rInner, rOuter] = TERRACE_RADII[lvl];
      const a = (i / MINARET_COUNT) * TAU + 0.6;
      const r = rOuter + 0.15;
      const mx = Math.cos(a) * r;
      const mz = Math.sin(a) * r;
      const baseY = TERRACE_LEVELS[lvl];
      const shaftH = 1.5 + rand() * 0.7;

      const shaft = new THREE.Mesh(shaftGeo, shaftMat);
      shaft.scale.set(0.16, shaftH, 0.16);
      shaft.position.set(mx, baseY + shaftH / 2, mz);
      root.add(shaft);

      const bulb = new THREE.Mesh(onionSphereGeo, onionMat);
      bulb.scale.set(0.2, 0.26, 0.2);
      bulb.position.set(mx, baseY + shaftH + 0.12, mz);
      detail.add(bulb);

      const spike = new THREE.Mesh(onionSpikeGeo, onionMat);
      spike.scale.set(0.45, 0.55, 0.45);
      spike.position.set(mx, baseY + shaftH + 0.32, mz);
      detail.add(spike);
    }

    // --- THE GREAT TOWER (shared shaft geometry, scaled up) ------------------
    const tower = new THREE.Mesh(shaftGeo, shaftMat);
    tower.scale.set(0.62, TOWER_HEIGHT, 0.62);
    tower.position.set(0, TOWER_BASE_Y + TOWER_HEIGHT / 2, 0);
    root.add(tower);

    const beacon = new THREE.Mesh(beaconCoreGeo, beaconMat);
    beacon.position.set(0, TOWER_TOP_Y + 0.3, 0);
    root.add(beacon);
    const beaconGlow = new THREE.Mesh(beaconGlowGeo, beaconGlowMat);
    beaconGlow.position.copy(beacon.position);
    root.add(beaconGlow);

    beaconLight = new THREE.PointLight(accent.getHex(), 1.8, 16, 2);
    beaconLight.position.copy(beacon.position);
    root.add(beaconLight);

    root.add(detail);

    // --- dust motes (seeded, drifting sideways through the whole scene) ------
    moteData = [];
    for (let i = 0; i < DUST_COUNT; i++) {
      moteData.push({
        baseX: (rand() - 0.5) * 13,
        baseY: -1 + rand() * 11,
        baseZ: (rand() - 0.5) * 13,
        driftSpeed: 0.06 + rand() * 0.1,
        driftRange: 0.8 + rand() * 1.4,
        phase: rand() * TAU,
      });
    }
    dustPositions = new Float32Array(DUST_COUNT * 3);
    const dustGeo = track(new THREE.BufferGeometry());
    const dustAttr = new THREE.BufferAttribute(dustPositions, 3);
    dustAttr.setUsage(THREE.DynamicDrawUsage); // rewritten every frame in placeDust()
    dustGeo.setAttribute('position', dustAttr);
    dust = new THREE.Points(dustGeo, dustMat);
    dust.frustumCulled = false; // positions mutate every frame; skip stale-bounds culling
    root.add(dust);
    placeDust(); // lay out at t=0 so the first frame isn't a clump at origin

    applyQuality();
  }

  function placeDust(): void {
    if (!dust || !dustPositions) return;
    const n = dustCount();
    for (let i = 0; i < n; i++) {
      const m = moteData[i];
      dustPositions[i * 3] = m.baseX + Math.sin(driftTime * m.driftSpeed + m.phase) * m.driftRange;
      dustPositions[i * 3 + 1] = m.baseY + Math.sin(driftTime * 0.2 + m.phase) * 0.15;
      dustPositions[i * 3 + 2] = m.baseZ + Math.cos(driftTime * m.driftSpeed * 0.8 + m.phase) * m.driftRange;
    }
    (dust.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  function update(dt: number, progress: number, active: boolean): void {
    if (!active) return;
    if (!ctx || !root) return; // not built yet — DioramaCanvas never does this, but stay safe

    // --- camera: pure function of progress ---------------------------------
    // Start low at the cliff base looking up the vertical town; spiral up
    // and around ~50 deg to end level with the great tower's beacon,
    // looking out across the summit.
    const p = smoothstep(Math.min(Math.max(progress, 0), 1));
    const angle = 0.25 + p * ((50 * Math.PI) / 180);
    const radius = lerp(8.2, 4.4, p);
    const camY = lerp(-1.2, TOWER_TOP_Y - 0.2, p);
    const cam = ctx.camera;
    cam.position.set(Math.sin(angle) * radius, camY, Math.cos(angle) * radius);
    const lookY = lerp(3.4, TOWER_TOP_Y + 0.1, p);
    const lookX = lerp(0, 0.9, p);
    const lookZ = lerp(0, -1.4, p);
    cam.lookAt(lookX, lookY, lookZ);

    // Signature move: the rake spotlight's target climbs the great tower's
    // shaft as progress advances, purely a function of progress (see the
    // determinism rule above) so the lit band's height is scrub-scrubbable.
    if (rakeTarget) rakeTarget.position.y = lerp(TOWER_BASE_Y, TOWER_TOP_Y + 0.4, p);

    // --- ambient drift: the only dt-accumulated motion ---------------------
    driftTime += dt;
    if (beaconLight) beaconLight.intensity = 1.8 + Math.sin(driftTime * 3.6) * 0.2; // beacon pulse
    placeDust();
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
    dust = null;
    dustPositions = null;
    moteData = [];
    beaconLight = null;
    rakeLight = null;
    rakeTarget = null;
    ctx = null;
  }

  return { id: 'citadel', build, update, setQuality, dispose };
}
