import * as THREE from 'three';

/**
 * THE LIQUID SURFACE: lava here, and whatever the next planet pours.
 *
 * Two shapes, because two shapes is what a descriptor can express: a `disc`
 * (lake, pond, crater fill) and a `ribbon` (a flow following a polyline, its
 * surface interpolating linearly in arclength from `y0` to `y1` - exactly the
 * way a `ramp` landform interpolates the ground under it, so the two cannot
 * separate).
 *
 * -- Why one material and not a shader per planet -------------------------
 * The look is `onBeforeCompile` over a `MeshStandardMaterial` rather than a
 * bare `ShaderMaterial`. That is not a shortcut - it is the only way this
 * surface gets the world's fog, its tone mapping and its shadow reception for
 * free. A raw `ShaderMaterial` lava lake looks correct at 20 m and then hangs
 * in the air unfogged at 400 m, which on a planet whose fog is the atmosphere
 * is the whole illusion gone.
 *
 * -- The skirt ------------------------------------------------------------
 * Every body hangs a vertical apron below its edge, for the same reason
 * `TerrainTiles` hangs one off every terrain tile: a drawn edge that misses the
 * ground by anything at all is a strip of sky, and here it would be a strip of
 * sky under a lava lake.
 *
 * The disagreement is measured, over 128 bearings per disc and both edges of
 * every ribbon sample (`planet-relief.test.mjs`). On Cinder the worst is 5.30 m
 * and it is not noise - it is structural, and it is worth writing down because
 * the next planet will hit it too. Where a flow at a 0.19 grade runs into a
 * flat lake bed, the bed's `pad` levels the ground several metres before the
 * flow's own linear descent gets there, so the last stretch of ribbon crosses a
 * delta. Shortening the ribbon leaves a gap between it and the lake; steepening
 * the beach puts a 41-degree wall round the shore. An apron is the cheap answer
 * and it is what an apron is for.
 *
 * 8 m: 1.5x the measured worst case, and invisible - it hangs inside the bank
 * everywhere else on the planet.
 */

/** How far each body's apron hangs below its surface. See the header. */
export const SKIRT = 8.0;

const LAVA_CHUNK = /* glsl */`
  float lavaHash(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }
  float lavaNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = lavaHash(i);
    float b = lavaHash(i + vec2(1.0, 0.0));
    float c = lavaHash(i + vec2(0.0, 1.0));
    float d = lavaHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }
`;

/**
 * The one lava material. Cloned per world, shared across every body on it.
 *
 * @param {object} liquid the descriptor's `liquid` block
 * @returns {{ material: THREE.MeshStandardMaterial, uniforms: object }}
 */
export function createLiquidMaterial(liquid) {
  const uniforms = {
    uTime: { value: 0 },
    uFlow: { value: liquid.flow ?? 0.5 },
    uHot: { value: new THREE.Color(liquid.hot ?? 0xff7a1c) },
    uCrust: { value: new THREE.Color(liquid.crust ?? 0x140b0a) },
    uDeep: { value: new THREE.Color(liquid.color ?? 0x3d0a04) },
    uEmissive: { value: liquid.emissive ?? 2.5 },
  };

  const material = new THREE.MeshStandardMaterial({
    name: 'planet.liquid',
    color: 0xffffff,
    roughness: 0.62,
    metalness: 0.0,
    emissive: new THREE.Color(0x000000),
    emissiveIntensity: 1.0,
  });

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = `varying vec3 vLavaW;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vLavaW = (modelMatrix * vec4(transformed, 1.0)).xyz;'
    );

    shader.fragmentShader = `
      varying vec3 vLavaW;
      uniform float uTime;
      uniform float uFlow;
      uniform vec3 uHot;
      uniform vec3 uCrust;
      uniform vec3 uDeep;
      uniform float uEmissive;
      ${LAVA_CHUNK}
      ${shader.fragmentShader}
    `.replace(
      '#include <emissivemap_fragment>',
      /* glsl */`
      #include <emissivemap_fragment>
      {
        /* Two drift rates, deliberately not multiples of one another. A crust
         * scrolling as one sheet reads as a texture on a conveyor; two layers
         * shearing past each other read as a skin tearing, which is what it is. */
        vec2 q = vLavaW.xz * 0.055;
        vec2 drift = vec2(uTime * uFlow * 0.035, uTime * uFlow * 0.014);
        float n = lavaNoise(q + drift) * 0.58
                + lavaNoise(q * 2.7 + drift * 2.1 + 13.0) * 0.29
                + lavaNoise(q * 6.3 - drift * 0.7) * 0.13;

        /* Veins where the crust has pulled apart.
         *
         * The band was 0.20 wide and the flow read as cold rock from any low
         * angle: a vein a few centimetres across is sub-pixel at 200 m and at a
         * grazing angle it is compressed to nothing, so the whole 340 m of
         * outlet gorge came back in a review screenshot looking like a road.
         * 0.26 makes the veins metres across, which is what they are on a flow
         * this size - and 0.34, which was the first correction, made the whole
         * gorge a lightbox with no crust left in it at all. */
        float band = abs(fract(n * 3.4) - 0.5) * 2.0;
        float crack = 1.0 - smoothstep(0.0, 0.26, band);
        // Broad molten patches where it has not skinned over at all. The old
        // 0.63 threshold sat above almost the whole range of a 3-octave fbm.
        float open = smoothstep(0.58, 0.80, n);
        float glow = clamp(crack * 0.9 + open, 0.0, 1.6);

        diffuseColor.rgb = mix(uCrust, uDeep, clamp(glow, 0.0, 1.0));
        /* The 0.045 floor is the crust's own residual heat. Without it the
         * unbroken skin is literally black, and a black lake is a hole. */
        totalEmissiveRadiance += uHot * uEmissive * (glow * 0.58 + 0.045);
      }
      `
    );
  };
  /* Anything compiled through `onBeforeCompile` needs a cache key or three
   * hands every clone the first one's program. */
  material.customProgramCacheKey = () => 'planet.liquid.v1';

  return { material, uniforms };
}

/** Dark chilled rock, for the aprons. Never emissive: an apron that glowed
 *  would light the ground it is hidden under. */
export function createSkirtMaterial(liquid) {
  return new THREE.MeshStandardMaterial({
    name: 'planet.liquid.skirt',
    color: new THREE.Color(liquid.crust ?? 0x140b0a),
    roughness: 0.9,
    metalness: 0.0,
  });
}

/**
 * Surface + apron geometry for one body.
 *
 * @param {object} b a descriptor `liquid.bodies[i]` record
 * @returns {{ surface: THREE.BufferGeometry, skirt: THREE.BufferGeometry }}
 */
export function bodyGeometry(b) {
  if (b.shape === 'disc') return discGeometry(b);
  return ribbonGeometry(b);
}

/**
 * A disc body's radius on a given bearing.
 *
 * THE SHORELINE IS NOT A CIRCLE, and this is the one function that says so.
 * The first review screenshot of the crater lake came back with a geometrically
 * perfect circle of lava sitting on the crater floor: it read as a decal
 * somebody had dropped on the terrain, and no amount of shader work on the
 * surface fixed it, because the tell was the outline.
 *
 * Two low harmonics plus a third at the seed's phase - enough to make the
 * outline read as a shore and not enough to make it read as a star. `wobble`
 * defaults to 0.09, i.e. +-9% of the radius.
 *
 * Exported because the shoreline TEST has to sample the same outline the mesh
 * draws. A test that measured the nominal radius while the mesh drew a wobbly
 * one would be measuring a shore that does not exist - which is the same class
 * of error as a collider that disagrees with its mesh, one dimension down.
 */
export function discRadiusAt(b, angle) {
  const w = b.wobble ?? 0.09;
  if (w <= 0) return b.r;
  const p = (b.phase ?? 0) + (b.x + b.z) * 0.017;
  return b.r * (1 + w * (
    0.60 * Math.sin(angle * 3 + p)
    + 0.28 * Math.sin(angle * 5 - p * 1.7)
    + 0.12 * Math.sin(angle * 8 + p * 0.6)
  ));
}

function discGeometry(b) {
  const seg = Math.max(48, Math.min(128, Math.round(b.r * 2.4)));
  const pos = new Float32Array((seg + 1) * 3);
  const uv = new Float32Array((seg + 1) * 2);
  pos[0] = b.x; pos[1] = b.y; pos[2] = b.z;
  uv[0] = 0.5; uv[1] = 0.5;
  const rim = new Float32Array(seg * 2);
  for (let i = 0; i < seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    const r = discRadiusAt(b, a);
    rim[i * 2] = b.x + Math.cos(a) * r;
    rim[i * 2 + 1] = b.z + Math.sin(a) * r;
    pos[(i + 1) * 3] = rim[i * 2];
    pos[(i + 1) * 3 + 1] = b.y;
    pos[(i + 1) * 3 + 2] = rim[i * 2 + 1];
    uv[(i + 1) * 2] = 0.5 + Math.cos(a) * 0.5;
    uv[(i + 1) * 2 + 1] = 0.5 + Math.sin(a) * 0.5;
  }
  /* Wound so the fan faces UP. The rim runs anticlockwise in (cos, sin), which
   * puts (centre, i, i+1) anticlockwise as seen from BELOW - i.e. face-down,
   * culled from every position a player can stand in. Swapping the last two
   * indices is the whole fix; `liquid-facing` in `planet-relief.test.mjs`
   * caught this and the ribbon's identical mistake in the same run. */
  const idx = [];
  for (let i = 0; i < seg; i++) idx.push(0, ((i + 1) % seg) + 1, i + 1);
  const surface = new THREE.BufferGeometry();
  surface.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  surface.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  surface.setIndex(idx);
  surface.computeVertexNormals();

  // The apron, hung off the same rim so it cannot part company with it.
  const sp = new Float32Array(seg * 6 * 3);
  let t = 0;
  const put = (x, y, z) => { sp[t++] = x; sp[t++] = y; sp[t++] = z; };
  for (let i = 0; i < seg; i++) {
    const j = (i + 1) % seg;
    const ax = rim[i * 2]; const az = rim[i * 2 + 1];
    const bx = rim[j * 2]; const bz = rim[j * 2 + 1];
    put(ax, b.y, az); put(ax, b.y - SKIRT, az); put(bx, b.y - SKIRT, bz);
    put(ax, b.y, az); put(bx, b.y - SKIRT, bz); put(bx, b.y, bz);
  }
  const skirt = new THREE.BufferGeometry();
  skirt.setAttribute('position', new THREE.BufferAttribute(sp, 3));
  skirt.computeVertexNormals();

  return { surface, skirt };
}

/**
 * A flow ribbon.
 *
 * Built as a strip of quads along the polyline, its Y taken from the SAME
 * linear-in-arclength interpolation the `ramp` landform under it uses. Not
 * per-segment-linear: interpolating between the two endpoints of each segment
 * separately would give a different surface wherever the segments are unequal,
 * and lava that sits 40 cm proud of its own channel is the sort of thing that
 * only shows up in a screenshot.
 */
function ribbonGeometry(b) {
  const pts = b.pts;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  }
  const total = cum[cum.length - 1];

  // Resample so a long straight leg is not one enormous quad: the liquid
  // material's detail is per-fragment, but the fog and the vertex lighting are
  // not, and a 100 m quad fogs from its corners.
  const STEP = 6;
  const samples = [];
  for (let i = 0; i + 1 < pts.length; i++) {
    const segLen = cum[i + 1] - cum[i];
    const n = Math.max(1, Math.round(segLen / STEP));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      samples.push({
        x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * t,
        z: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * t,
        s: (cum[i] + segLen * t) / total,
        dx: pts[i + 1][0] - pts[i][0],
        dz: pts[i + 1][1] - pts[i][1],
      });
    }
  }
  const last = pts[pts.length - 1];
  const prev = pts[pts.length - 2];
  samples.push({ x: last[0], z: last[1], s: 1, dx: last[0] - prev[0], dz: last[1] - prev[1] });

  const n = samples.length;
  const pos = new Float32Array(n * 2 * 3);
  const uv = new Float32Array(n * 2 * 2);
  const sPos = new Float32Array(n * 2 * 3);
  const half = b.width * 0.5;

  for (let i = 0; i < n; i++) {
    const p = samples[i];
    const len = Math.hypot(p.dx, p.dz) || 1;
    const nx = -p.dz / len;
    const nz = p.dx / len;
    const y = b.y0 + (b.y1 - b.y0) * p.s;
    for (const [k, sgn] of [[0, -1], [1, 1]]) {
      const idx = (i * 2 + k) * 3;
      pos[idx] = p.x + nx * half * sgn;
      pos[idx + 1] = y;
      pos[idx + 2] = p.z + nz * half * sgn;
      uv[(i * 2 + k) * 2] = k;
      uv[(i * 2 + k) * 2 + 1] = p.s * total * 0.1;
      sPos[idx] = pos[idx];
      sPos[idx + 1] = y - SKIRT;
      sPos[idx + 2] = pos[idx + 2];
    }
  }

  /* Wound so the face normals point UP.
   *
   * The first version wound them the other way and the entire outlet gorge was
   * backface-culled: 340 m of lava river simply was not in the frame, and it
   * looked exactly like a lava river that had cooled - which is why it survived
   * three review screenshots. `computeVertexNormals` cannot save this; it
   * derives the normal FROM the winding, so a face-down ribbon also gets lit
   * from underneath. `liquid-facing` in `planet-relief.test.mjs` now measures
   * it, because "is this polygon inside out" is not something a screenshot can
   * be trusted to answer.
   *
   * The left edge (k=0) is at `-n` and the right (k=1) at `+n`, where
   * `n = (-dz, dx)/len`. With travel along +x that puts the left edge at -z, so
   * (v0_i, v1_{i+1}, v0_{i+1}) is counter-clockwise seen from +y. */
  const index = [];
  for (let i = 0; i + 1 < n; i++) {
    const a = i * 2;
    index.push(a, a + 3, a + 2, a, a + 1, a + 3);
  }

  const surface = new THREE.BufferGeometry();
  surface.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  surface.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  surface.setIndex(index);
  surface.computeVertexNormals();

  /* The apron is two vertical strips, one down each edge, wound so both face
   * outward. A single skirt round the whole outline would need the ribbon's
   * boundary loop; two strips need only the edge columns already computed. */
  const skirtPos = [];
  for (let i = 0; i + 1 < n; i++) {
    for (const k of [0, 1]) {
      const a = (i * 2 + k) * 3;
      const c = ((i + 1) * 2 + k) * 3;
      const flip = k === 0;
      const t0 = [pos[a], pos[a + 1], pos[a + 2]];
      const t1 = [pos[c], pos[c + 1], pos[c + 2]];
      const b0 = [sPos[a], sPos[a + 1], sPos[a + 2]];
      const b1 = [sPos[c], sPos[c + 1], sPos[c + 2]];
      const tri = flip
        ? [t0, b0, b1, t0, b1, t1]
        : [t0, b1, b0, t0, t1, b1];
      for (const v of tri) skirtPos.push(v[0], v[1], v[2]);
    }
  }
  const skirt = new THREE.BufferGeometry();
  skirt.setAttribute('position', new THREE.BufferAttribute(new Float32Array(skirtPos), 3));
  skirt.computeVertexNormals();

  return { surface, skirt };
}
