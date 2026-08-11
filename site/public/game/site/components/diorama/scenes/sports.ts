import type * as THREE from 'three';
import type { DioramaScene, SceneCtx, QualityTier } from '../types';
import { mulberry32, smoothstep, lerp, TAU } from '@/lib/sceneMath';

/**
 * Meridian Athletic Grounds — the skill-world diorama (id 'sports').
 *
 * Composition (world units, 50° fov camera at ~2.6–21 units):
 * - a sunken stadium bowl: three stacked ring tiers (one shared torus
 *   geometry, uniformly scaled per tier) ringed with a green emissive edge
 *   trim, plus a seeded crowd-shimmer point field scattered across the
 *   risers,
 * - a flat running track — a terracotta ring plus a thin white lane-hint
 *   ring — around a green infield disc,
 * - four floodlight pylons at the bowl's corners (shared shaft/panel/cone
 *   geometry), each topped with a bright emissive panel and an additive
 *   light-cone beam aimed in at the field,
 * - a glinting blue-cyan pool rectangle and a skatepark half-pipe hint to
 *   one side, a small white ski-piste wedge on the other,
 * - cool night `FogExp2`, a dim blue ambient, a strong white-green
 *   "floodlight" directional light, and a green point light over the bowl.
 *
 * Determinism rule: camera position/orientation derive purely from
 * `progress` (see station.ts for the reference). Only ambient drift (crowd
 * shimmer flicker, bowl-light flicker, trim-ring creep, one floodlight
 * cone's slow sweep) accumulates via `dt`. Crowd layout is seeded
 * (mulberry32) for build-to-build determinism.
 */

const CROWD_COUNT = 800;
const PYLON_COUNT = 4;
const PYLON_RADIUS = 9.4;
const PYLON_SHAFT_HEIGHT = 6.4;
const BASE_RING_RADIUS = 4.6;
const BASE_TUBE_RADIUS = 0.42;

interface Tier {
  scale: number;
  y: number;
}

const TIERS: Tier[] = [
  { scale: 1.0, y: 0.3 },
  { scale: 1.14, y: 0.85 },
  { scale: 1.28, y: 1.45 },
];
const TIER_COUNT = TIERS.length;

export function createSportsScene(): DioramaScene {
  // --- closure state, populated once in build() -----------------------------
  let ctx: SceneCtx | null = null;
  let root: THREE.Group | null = null;
  const disposables: Array<{ dispose(): void }> = [];

  let detail: THREE.Group | null = null; // trim ring, lane ring, panels + light cones — culled on 'low'
  let crowd: THREE.Points | null = null;
  let crowdMat: THREE.PointsMaterial | null = null;
  let bowlLight: THREE.PointLight | null = null;
  let trimRing: THREE.Mesh | null = null;
  let sweepAim: THREE.Group | null = null;
  let sweepBaseAngle = 0;

  let tier: QualityTier = 'high';
  // Ambient accumulators — the ONLY dt-driven state (see determinism rule).
  let driftTime = 0;

  function track<T extends { dispose(): void }>(d: T): T {
    disposables.push(d);
    return d;
  }

  function crowdCount(): number {
    return tier === 'high' ? CROWD_COUNT : tier === 'medium' ? 450 : 200;
  }

  function applyQuality(): void {
    if (!crowd || !detail) return;
    crowd.geometry.setDrawRange(0, crowdCount());
    detail.visible = tier !== 'low';
  }

  function build(c: SceneCtx): void {
    ctx = c;
    tier = c.quality;
    const { THREE, scene, accent } = c;
    const rand = mulberry32(0x4d65_7269); // 'sports' seed — fixed forever

    scene.fog = new THREE.FogExp2(0x040a12, 0.026);

    root = new THREE.Group();
    scene.add(root);

    // --- lighting -------------------------------------------------------------
    root.add(new THREE.AmbientLight(0x18243a, 0.42));
    const flood = new THREE.DirectionalLight(0xdcffe6, 1.25);
    flood.position.set(2, 16, 6);
    root.add(flood);
    bowlLight = new THREE.PointLight(accent.getHex(), 1.5, 24, 2);
    bowlLight.position.set(0, 5.2, 0);
    root.add(bowlLight);

    // --- shared materials -------------------------------------------------
    const bowlMat = track(
      new THREE.MeshLambertMaterial({ color: 0x3b4250, emissive: 0x0b0e14 }),
    );
    const trimMat = track(
      new THREE.MeshBasicMaterial({
        color: accent.getHex(),
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.55,
        depthWrite: false,
      }),
    );
    crowdMat = track(
      new THREE.PointsMaterial({
        color: accent.clone().lerp(new THREE.Color(0xffffff), 0.3),
        size: 0.12,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.7,
        depthWrite: false,
      }),
    );
    const trackMat = track(
      new THREE.MeshLambertMaterial({ color: 0xb5502c, emissive: 0x180a04 }),
    );
    const laneMat = track(new THREE.MeshBasicMaterial({ color: 0xf3f2ea }));
    const infieldMat = track(
      new THREE.MeshLambertMaterial({ color: 0x1f6b3a, emissive: 0x081f10 }),
    );
    const pylonMat = track(
      new THREE.MeshLambertMaterial({ color: 0x333e4c, emissive: 0x0a0e14 }),
    );
    const panelMat = track(new THREE.MeshBasicMaterial({ color: 0xeafff2 }));
    const coneMat = track(
      new THREE.MeshBasicMaterial({
        color: accent.getHex(),
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.14,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const poolMat = track(
      new THREE.MeshPhongMaterial({
        color: 0x0b3a4a,
        specular: 0x8fe8ff,
        shininess: 140,
        emissive: 0x02171d,
      }),
    );
    const halfpipeMat = track(
      new THREE.MeshLambertMaterial({ color: 0x394454, emissive: 0x0a0e14 }),
    );
    const snowMat = track(
      new THREE.MeshLambertMaterial({ color: 0xeef3fa, emissive: 0x1b2430 }),
    );

    detail = new THREE.Group();

    // --- stadium bowl: 3 tiers sharing one torus geometry ---------------------
    const tierGeo = track(new THREE.TorusGeometry(BASE_RING_RADIUS, BASE_TUBE_RADIUS, 10, 40));
    for (const t of TIERS) {
      const mesh = new THREE.Mesh(tierGeo, bowlMat);
      mesh.rotation.x = Math.PI / 2; // lie in the horizontal plane
      mesh.scale.setScalar(t.scale);
      mesh.position.y = t.y;
      root.add(mesh);
    }
    const topTier = TIERS[TIERS.length - 1];
    const trimGeo = track(
      new THREE.TorusGeometry(
        (BASE_RING_RADIUS + BASE_TUBE_RADIUS) * topTier.scale,
        0.05,
        8,
        48,
      ),
    );
    trimRing = new THREE.Mesh(trimGeo, trimMat);
    trimRing.rotation.x = Math.PI / 2;
    trimRing.position.y = topTier.y + BASE_TUBE_RADIUS * topTier.scale + 0.1;
    detail.add(trimRing);

    // --- crowd shimmer (seeded scatter across the risers) ---------------------
    const crowdPositions = new Float32Array(CROWD_COUNT * 3);
    for (let i = 0; i < CROWD_COUNT; i++) {
      const tt = TIERS[Math.floor(rand() * TIER_COUNT)];
      const baseR = BASE_RING_RADIUS * tt.scale;
      const tubeR = BASE_TUBE_RADIUS * tt.scale;
      const radius = baseR + (rand() - 0.5) * tubeR * 1.6;
      const angle = rand() * TAU;
      crowdPositions[i * 3] = Math.cos(angle) * radius;
      crowdPositions[i * 3 + 1] = tt.y + rand() * tubeR * 0.85;
      crowdPositions[i * 3 + 2] = Math.sin(angle) * radius;
    }
    const crowdGeo = track(new THREE.BufferGeometry());
    crowdGeo.setAttribute('position', new THREE.BufferAttribute(crowdPositions, 3));
    crowd = new THREE.Points(crowdGeo, crowdMat);
    root.add(crowd);

    // --- running track + infield -----------------------------------------------
    const trackGeo = track(new THREE.RingGeometry(3.6, 4.55, 48));
    const trackMesh = new THREE.Mesh(trackGeo, trackMat);
    trackMesh.rotation.x = -Math.PI / 2;
    trackMesh.position.y = 0.01;
    root.add(trackMesh);

    const laneGeo = track(new THREE.RingGeometry(4.02, 4.08, 48));
    const laneMesh = new THREE.Mesh(laneGeo, laneMat);
    laneMesh.rotation.x = -Math.PI / 2;
    laneMesh.position.y = 0.02;
    detail.add(laneMesh);

    const infieldGeo = track(new THREE.CircleGeometry(3.62, 40));
    const infieldMesh = new THREE.Mesh(infieldGeo, infieldMat);
    infieldMesh.rotation.x = -Math.PI / 2;
    root.add(infieldMesh);

    // --- floodlight pylons (4, shared shaft/panel/cone geometry) --------------
    const pylonShaftGeo = track(new THREE.BoxGeometry(0.34, PYLON_SHAFT_HEIGHT, 0.34));
    const pylonPanelGeo = track(new THREE.BoxGeometry(1.3, 0.5, 0.18));
    const coneGeo = track(new THREE.ConeGeometry(1.6, 3.4, 16, 1, true));
    for (let i = 0; i < PYLON_COUNT; i++) {
      const a = Math.PI / 4 + (i / PYLON_COUNT) * TAU;
      const px = Math.cos(a) * PYLON_RADIUS;
      const pz = Math.sin(a) * PYLON_RADIUS;

      const shaft = new THREE.Mesh(pylonShaftGeo, pylonMat);
      shaft.position.set(px, PYLON_SHAFT_HEIGHT / 2, pz);
      root.add(shaft);

      const panel = new THREE.Mesh(pylonPanelGeo, panelMat);
      panel.position.set(px, PYLON_SHAFT_HEIGHT + 0.2, pz);
      panel.rotation.y = -a;
      detail.add(panel);

      // Aim pivot at the pylon top, facing the bowl; the cone hangs off it
      // tilted inward-down so its wide (base) end spreads over the field.
      const aim = new THREE.Group();
      aim.position.set(px, PYLON_SHAFT_HEIGHT + 0.1, pz);
      aim.rotation.y = -a;
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.y = -2.35;
      cone.rotation.z = -0.85;
      aim.add(cone);
      detail.add(aim);
      if (i === 0) {
        sweepAim = aim;
        sweepBaseAngle = -a;
      }
    }

    // --- pool, half-pipe, snow wedge (edge dressing) ---------------------------
    const poolGeo = track(new THREE.PlaneGeometry(4.2, 2.4));
    const pool = new THREE.Mesh(poolGeo, poolMat);
    pool.rotation.x = -Math.PI / 2;
    pool.position.set(-11, 0.02, 1.2);
    root.add(pool);

    const halfpipeGeo = track(
      new THREE.CylinderGeometry(1.6, 1.6, 3.0, 16, 1, true, 0, Math.PI),
    );
    const halfpipe = new THREE.Mesh(halfpipeGeo, halfpipeMat);
    halfpipe.rotation.z = Math.PI / 2;
    halfpipe.rotation.y = 0.3;
    halfpipe.position.set(11.4, 1.6, -6);
    root.add(halfpipe);

    const snowGeo = track(new THREE.BoxGeometry(2.6, 0.25, 1.7));
    const snowRamp = new THREE.Mesh(snowGeo, snowMat);
    snowRamp.rotation.x = -0.32;
    snowRamp.rotation.y = -0.3;
    snowRamp.position.set(11.4, 0.5, 6.2);
    root.add(snowRamp);

    root.add(detail);
    applyQuality();
  }

  function update(dt: number, progress: number, active: boolean): void {
    if (!active) return;
    if (!ctx || !root) return; // not built yet — DioramaCanvas never does this, but stay safe

    // --- camera: pure function of progress ---------------------------------
    // Start high above the bowl looking down the stadium axis; sweep down
    // and around ~40° to end at track level looking across the infield to
    // the lit stands.
    const p = smoothstep(Math.min(Math.max(progress, 0), 1));
    const cam = ctx.camera;
    const angle = 0.35 + p * ((40 * Math.PI) / 180);
    const radius = lerp(6.5, 10.5, p);
    const height = lerp(21, 2.6, p);
    cam.position.set(Math.sin(angle) * radius, height, Math.cos(angle) * radius);
    const lookX = lerp(0, 0.5, p);
    const lookY = lerp(3.6, 1.7, p);
    const lookZ = lerp(0, -5.2, p);
    cam.lookAt(lookX, lookY, lookZ);

    // --- ambient drift: the only dt-accumulated motion ---------------------
    driftTime += dt;
    if (bowlLight) bowlLight.intensity = 1.5 + Math.sin(driftTime * 5.1) * 0.18; // floodlight hum
    if (crowdMat) crowdMat.opacity = 0.7 + Math.sin(driftTime * 3.4) * 0.15; // crowd shimmer
    if (trimRing) trimRing.rotation.z = driftTime * 0.05;
    if (sweepAim) sweepAim.rotation.y = sweepBaseAngle + driftTime * 0.12; // sweeping floodlight
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
    crowd = null;
    crowdMat = null;
    bowlLight = null;
    trimRing = null;
    sweepAim = null;
    ctx = null;
  }

  return { id: 'sports', build, update, setQuality, dispose };
}
