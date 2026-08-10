import type * as THREE from 'three';
import type { DioramaScene, SceneCtx, QualityTier } from '../types';
import { mulberry32, smoothstep, lerp, TAU } from '@/lib/sceneMath';

/**
 * Aether Nexus Station — the hub-world diorama and the reference template for
 * the five scenes that follow.
 *
 * Composition (world units, 50° fov camera at 13–20 units):
 * - a large planet low in frame (vertex-colored gradient sphere + additive
 *   back-side atmosphere shell for the rim glow),
 * - the station at the origin: a luminous torus ring, a hub spire cluster,
 *   six docking gantries radiating to the ring,
 * - a seeded 800-point starfield (additive, fog-exempt),
 * - a dozen "traffic" lights drifting along two circular lanes near the ring.
 *
 * Determinism rule: camera position/orientation and every progress-driven pose
 * derive purely from `progress`. Only continuous ambient drift (ring rotation,
 * traffic advance, key-light flicker) accumulates via `dt`, so two scenes fed
 * the same (dt=0, progress) are bit-identical. Starfield randomness is seeded
 * (mulberry32) for the same reason.
 */

const STAR_COUNT = 800;
const TRAFFIC_COUNT = 12;

interface TrafficLane {
  radius: number;
  y: number;
  speed: number; // rad/s, signed (some lanes run counter-clockwise)
  phase: number;
}

export function createStationScene(): DioramaScene {
  // --- closure state, populated once in build() -----------------------------
  let ctx: SceneCtx | null = null;
  let root: THREE.Group | null = null;
  const disposables: Array<{ dispose(): void }> = [];

  let ring: THREE.Mesh | null = null;
  let glowRing: THREE.Mesh | null = null;
  let detail: THREE.Group | null = null; // small meshes culled on 'low'
  let stars: THREE.Points | null = null;
  let traffic: THREE.Points | null = null;
  let trafficPositions: Float32Array | null = null;
  let lanes: TrafficLane[] = [];
  let keyPoint: THREE.PointLight | null = null;

  let tier: QualityTier = 'high';
  // Ambient accumulators — the ONLY dt-driven state (see determinism rule).
  let ringSpin = 0;
  let driftTime = 0;

  const lookTarget = { x: 0, y: 0.6, z: 0 };

  function track<T extends { dispose(): void }>(d: T): T {
    disposables.push(d);
    return d;
  }

  function trafficCount(): number {
    return tier === 'low' ? 6 : TRAFFIC_COUNT;
  }

  function applyQuality(): void {
    if (!stars || !detail || !traffic) return;
    const starCount = tier === 'high' ? STAR_COUNT : tier === 'medium' ? 550 : 300;
    stars.geometry.setDrawRange(0, starCount);
    detail.visible = tier !== 'low';
    traffic.geometry.setDrawRange(0, trafficCount());
  }

  function build(c: SceneCtx): void {
    ctx = c;
    tier = c.quality;
    const { THREE, scene, accent } = c;
    const rand = mulberry32(0x5747_1041); // 'station' seed — fixed forever

    scene.fog = new THREE.FogExp2(0x04070d, 0.022);

    root = new THREE.Group();
    scene.add(root);

    // --- lighting -----------------------------------------------------------
    root.add(new THREE.AmbientLight(0x27354a, 0.55));
    const key = new THREE.DirectionalLight(0xbcd8ff, 1.0);
    key.position.set(-6, 8, 4);
    root.add(key);
    keyPoint = new THREE.PointLight(accent.getHex(), 1.4, 30, 2);
    keyPoint.position.set(0, 0.8, 0);
    root.add(keyPoint);

    // --- planet (low in frame, behind the station) --------------------------
    const planetGeo = track(new THREE.SphereGeometry(7, 48, 32));
    {
      // Vertex-colored gradient: deep ocean blue at the bottom → lit teal limb
      // toward the station, so the sphere reads as a shaded world with no texture.
      const pos = planetGeo.attributes.position;
      const colors = new Float32Array(pos.count * 3);
      const lo = new THREE.Color(0x0d2038);
      const hi = new THREE.Color(0x2c7f8f);
      const cTmp = new THREE.Color();
      for (let i = 0; i < pos.count; i++) {
        const t = smoothstep(Math.min(Math.max(pos.getY(i) / 7 * 0.5 + 0.5, 0), 1));
        cTmp.copy(lo).lerp(hi, t);
        colors[i * 3] = cTmp.r;
        colors[i * 3 + 1] = cTmp.g;
        colors[i * 3 + 2] = cTmp.b;
      }
      planetGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    }
    const planetMat = track(
      new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x0a1a2b }),
    );
    const planet = new THREE.Mesh(planetGeo, planetMat);
    planet.position.set(2.5, -10.5, -14);
    root.add(planet);

    // Atmosphere rim: slightly larger back-side additive shell.
    const atmoGeo = track(new THREE.SphereGeometry(7.35, 48, 32));
    const atmoMat = track(
      new THREE.MeshBasicMaterial({
        color: 0x3fb6d8,
        side: THREE.BackSide,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.22,
        depthWrite: false,
      }),
    );
    const atmo = new THREE.Mesh(atmoGeo, atmoMat);
    atmo.position.copy(planet.position);
    root.add(atmo);

    // --- shared station materials ------------------------------------------
    const hullMat = track(
      new THREE.MeshLambertMaterial({ color: 0x55677d, emissive: 0x0b1220 }),
    );
    const windowMat = track(
      new THREE.MeshBasicMaterial({ color: accent.clone().multiplyScalar(0.9) }),
    );

    // --- orbital ring -------------------------------------------------------
    const ringGeo = track(new THREE.TorusGeometry(5, 0.16, 12, 64));
    const ringMat = track(
      new THREE.MeshLambertMaterial({
        color: 0x16303c,
        emissive: accent.getHex(),
        emissiveIntensity: 0.85,
      }),
    );
    ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2; // lie in the horizontal plane
    root.add(ring);

    // Luminous halo ring just outside the structural one (additive, ethereal).
    const glowGeo = track(new THREE.TorusGeometry(5.55, 0.045, 8, 64));
    const glowMat = track(
      new THREE.MeshBasicMaterial({
        color: accent.getHex(),
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.5,
        depthWrite: false,
      }),
    );
    glowRing = new THREE.Mesh(glowGeo, glowMat);
    glowRing.rotation.x = Math.PI / 2;
    root.add(glowRing);

    // --- hub spire ----------------------------------------------------------
    const hub = new THREE.Group();
    const coreGeo = track(new THREE.CylinderGeometry(0.42, 0.6, 2.6, 12));
    hub.add(new THREE.Mesh(coreGeo, hullMat));
    const bandGeo = track(new THREE.CylinderGeometry(0.46, 0.46, 0.1, 12));
    const band = new THREE.Mesh(bandGeo, windowMat); // lit window ring
    band.position.y = 0.55;
    hub.add(band);
    const blockGeo = track(new THREE.BoxGeometry(0.55, 0.55, 0.55));
    for (let i = 0; i < 4; i++) {
      const block = new THREE.Mesh(blockGeo, hullMat);
      const a = (i / 4) * TAU + 0.4;
      block.position.set(Math.cos(a) * 0.65, -0.5 + i * 0.32, Math.sin(a) * 0.65);
      block.rotation.y = a;
      hub.add(block);
    }
    root.add(hub);

    // --- docking gantries (6, radiating hub → ring) -------------------------
    const gantryGeo = track(new THREE.BoxGeometry(4.1, 0.07, 0.07));
    detail = new THREE.Group();
    const padGeo = track(new THREE.BoxGeometry(0.3, 0.05, 0.3));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * TAU;
      const gantry = new THREE.Mesh(gantryGeo, hullMat);
      gantry.position.set(Math.cos(a) * 2.95, 0, Math.sin(a) * 2.95);
      gantry.rotation.y = -a;
      root.add(gantry);
      // Docking pad + beacon at the outer end — detail layer, hidden on 'low'.
      const pad = new THREE.Mesh(padGeo, hullMat);
      pad.position.set(Math.cos(a) * 4.85, 0.05, Math.sin(a) * 4.85);
      pad.rotation.y = -a;
      detail.add(pad);
      const beacon = new THREE.Mesh(padGeo, windowMat);
      beacon.scale.set(0.28, 0.9, 0.28);
      beacon.position.set(Math.cos(a) * 4.85, 0.12, Math.sin(a) * 4.85);
      detail.add(beacon);
    }
    // Antenna spire above the hub — also detail-tier.
    const antennaGeo = track(new THREE.CylinderGeometry(0.025, 0.045, 1.7, 6));
    const antenna = new THREE.Mesh(antennaGeo, hullMat);
    antenna.position.y = 2.1;
    detail.add(antenna);
    const tipGeo = track(new THREE.SphereGeometry(0.07, 8, 6));
    const tip = new THREE.Mesh(tipGeo, windowMat);
    tip.position.y = 3.0;
    detail.add(tip);
    root.add(detail);

    // --- starfield (fixed, fog-exempt, seeded) ------------------------------
    const starGeo = track(new THREE.BufferGeometry());
    {
      const positions = new Float32Array(STAR_COUNT * 3);
      for (let i = 0; i < STAR_COUNT; i++) {
        // Uniform-ish shell: random direction, radius 55–95.
        const u = rand() * 2 - 1;
        const phi = rand() * TAU;
        const r = 55 + rand() * 40;
        const s = Math.sqrt(1 - u * u);
        positions[i * 3] = s * Math.cos(phi) * r;
        positions[i * 3 + 1] = u * r;
        positions[i * 3 + 2] = s * Math.sin(phi) * r;
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    }
    const starMat = track(
      new THREE.PointsMaterial({
        color: 0xcfe6ff,
        size: 0.55,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        opacity: 0.85,
        depthWrite: false,
        fog: false, // stars sit beyond the fog falloff; keep them crisp
      }),
    );
    stars = new THREE.Points(starGeo, starMat);
    root.add(stars);

    // --- drifting traffic lights (lanes near the ring) ----------------------
    lanes = [];
    for (let i = 0; i < TRAFFIC_COUNT; i++) {
      const outer = i % 2 === 0;
      lanes.push({
        radius: outer ? 6.1 : 6.7,
        y: (rand() - 0.5) * 0.9,
        speed: (outer ? 0.16 : -0.11) * (0.8 + rand() * 0.5),
        phase: rand() * TAU,
      });
    }
    trafficPositions = new Float32Array(TRAFFIC_COUNT * 3);
    const trafficGeo = track(new THREE.BufferGeometry());
    const trafficPosAttr = new THREE.BufferAttribute(trafficPositions, 3);
    trafficPosAttr.setUsage(THREE.DynamicDrawUsage); // rewritten every frame in placeTraffic()
    trafficGeo.setAttribute('position', trafficPosAttr);
    const trafficMat = track(
      new THREE.PointsMaterial({
        color: accent.getHex(),
        size: 0.22,
        sizeAttenuation: true,
        blending: THREE.AdditiveBlending,
        transparent: true,
        depthWrite: false,
      }),
    );
    traffic = new THREE.Points(trafficGeo, trafficMat);
    traffic.frustumCulled = false; // positions mutate every frame; skip stale-bounds culling
    root.add(traffic);
    placeTraffic(); // lay lights out at t=0 so the first frame isn't a clump at origin

    applyQuality();
  }

  function placeTraffic(): void {
    if (!traffic || !trafficPositions) return;
    const n = trafficCount();
    for (let i = 0; i < n; i++) {
      const lane = lanes[i];
      const a = lane.phase + lane.speed * driftTime;
      trafficPositions[i * 3] = Math.cos(a) * lane.radius;
      trafficPositions[i * 3 + 1] = lane.y + Math.sin(a * 3) * 0.06;
      trafficPositions[i * 3 + 2] = Math.sin(a) * lane.radius;
    }
    (traffic.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }

  function update(dt: number, progress: number, active: boolean): void {
    if (!active) return;
    if (!ctx || !root) return; // not built yet — DioramaCanvas never does this, but stay safe

    // --- camera: pure function of progress ---------------------------------
    // Wide and high over the planet at 0; slow dolly-in + ~30° orbit to 1,
    // always looking at the hub.
    const p = smoothstep(Math.min(Math.max(progress, 0), 1));
    const angle = 0.15 + p * (Math.PI / 6);
    const radius = lerp(20, 13, p);
    const height = lerp(7, 3.2, p);
    const cam = ctx.camera;
    cam.position.set(Math.sin(angle) * radius, height, Math.cos(angle) * radius);
    cam.lookAt(lookTarget.x, lookTarget.y, lookTarget.z);

    // --- ambient drift: the only dt-accumulated motion ---------------------
    ringSpin += dt * 0.03;
    driftTime += dt;
    if (ring) ring.rotation.z = ringSpin;
    if (glowRing) glowRing.rotation.z = -ringSpin * 0.6;
    if (keyPoint) keyPoint.intensity = 1.4 + Math.sin(driftTime * 6.3) * 0.12; // subtle flicker
    placeTraffic();
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
    ring = glowRing = null;
    detail = null;
    stars = traffic = null;
    trafficPositions = null;
    lanes = [];
    keyPoint = null;
    ctx = null;
  }

  return { id: 'station', build, update, setQuality, dispose };
}
