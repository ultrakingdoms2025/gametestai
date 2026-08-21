import * as THREE from 'three';
import { scatter } from './Placement.js';

/**
 * THE PROP FAMILIES: the only part of a planet that is SHAPE rather than data.
 *
 * A descriptor says "150 columns on that disc, 0.9 to 2.3 m across, 3.5 to 13 m
 * tall". What a column IS - a hexagonal prism with a chipped top, one draw call
 * for all of them - lives here, because that is geometry and geometry is code.
 *
 * The boundary is deliberate and it is the one that keeps the tenth planet
 * cheap. A new PLACE for basalt costs a record in a descriptor. A new SHAPE -
 * ice spires, coral, wind-carved arches - costs a `kind` in this file, and then
 * every planet after it can use that shape by naming it. Nothing here knows
 * which planet it is building for.
 *
 * -- Draw calls -----------------------------------------------------------
 * Every family is ONE `InstancedMesh`. Cinder places 1,186 props and draws them
 * in five calls. Built one mesh at a time it would be 1,186 draws, which is the
 * budget for the whole frame in this project three times over.
 *
 * -- Colliders ------------------------------------------------------------
 * Only what a body can actually meet. A 4 m basalt column is a wall and gets a
 * box; a 60 cm obsidian shard is scenery and gets nothing. The rule is in the
 * descriptor (`collide`), because whether a thing is an obstacle is a property
 * of the planet's design, not of the shape.
 */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

/** Pick one of `list` with a small lightness jitter, so no two repeat exactly. */
function tintOf(list, r) {
  const base = list[(r * list.length) | 0] ?? 0x888888;
  const f = 0.85 + r * 0.3;
  _c.setHex(base);
  _c.multiplyScalar(f);
  return _c;
}

/**
 * Geometry per kind, built once per field.
 *
 * Every one is authored around a UNIT footprint (radius 1, height 1, origin at
 * the base) so the instance matrix carries all the size. That keeps one
 * geometry per family however many size bands a descriptor asks for.
 */
function geometryFor(kind, size) {
  switch (kind) {
    case 'columns': {
      /* A hexagonal prism, because that is what cooling basalt does - and it is
       * the single most legible "this is volcanic" shape there is. Origin at
       * the base so the instance matrix's Y is the ground. */
      const g = new THREE.CylinderGeometry(1, 1.04, 1, size.sides ?? 6, 1, false);
      g.translate(0, 0.5, 0);
      return g;
    }
    case 'shards': {
      // Four-sided spike. Obsidian fractures conchoidally; a four-sided cone is
      // the cheapest thing that catches a highlight on one facet at a time.
      const g = new THREE.ConeGeometry(1, 1, 4, 1);
      g.translate(0, 0.5, 0);
      return g;
    }
    case 'boulders': {
      // Icosahedron at detail 0: 20 flat faces, which under a low sun gives an
      // ejecta block a different value on every side for 20 triangles.
      const g = new THREE.IcosahedronGeometry(1, 0);
      return g;
    }
    case 'vents': {
      // A flared mouth: a truncated cone, open at both ends so you can see down
      // it, with the wide end at the ground.
      const g = new THREE.CylinderGeometry(0.55, 1, 1, 9, 1, true);
      g.translate(0, 0.5, 0);
      return g;
    }
    default:
      throw new Error(`[PlanetProps] unknown prop kind "${kind}"`);
  }
}

/**
 * Build one prop field.
 *
 * @param {object} spec the descriptor's `props[i]` record
 * @param {{ height:(x,z)=>number, half:number, slopeStep:number, seed:number,
 *           liquid:object|null, landing:object[], material:THREE.Material,
 *           physics:any, group:THREE.Group, track:(c:any)=>any }} ctx
 * @returns {{ mesh: THREE.InstancedMesh, placed: number, requested: number,
 *             colliders: number, points: object[] }}
 */
export function buildPropField(spec, ctx) {
  const res = scatter({
    region: spec.region,
    count: spec.count,
    spacing: spec.spacing ?? 0,
    seed: ctx.seed,
    height: ctx.height,
    half: ctx.half,
    slopeStep: ctx.slopeStep,
    liquid: ctx.liquid,
    landing: ctx.landing,
  });

  const geo = geometryFor(spec.kind, spec.size ?? {});
  const mesh = new THREE.InstancedMesh(geo, ctx.material, Math.max(1, res.points.length));
  mesh.name = `planet:prop:${spec.id}`;
  mesh.castShadow = spec.kind !== 'shards';
  mesh.receiveShadow = true;
  mesh.count = res.points.length;

  const sz = spec.size ?? {};
  let colliders = 0;

  for (let i = 0; i < res.points.length; i++) {
    const pt = res.points[i];
    /* A second stream off the point's own stored roll rather than a shared
     * generator: the placement loop rejects candidates, so a generator consumed
     * here would advance a different number of times depending on how many
     * rejections happened before this point, and every instance downstream
     * would shift the moment a filter changed. */
    const a = pt.rnd;
    const b = (a * 7.13) % 1;
    const c = (a * 31.7) % 1;
    const d = (a * 113.9) % 1;

    let sx; let sy; let sz2; let rotX = 0; let rotZ = 0; let sink = 0;
    switch (spec.kind) {
      case 'columns': {
        const r = (sz.rMin ?? 1) + a * ((sz.rMax ?? 2) - (sz.rMin ?? 1));
        /* Height correlates with radius, inverted: the thin columns are the
         * tall ones. That is how a real colonnade reads, and it also means the
         * silhouette has a range in it rather than one repeated stick. */
        const h = (sz.hMin ?? 3) + (1 - a) * ((sz.hMax ?? 10) - (sz.hMin ?? 3)) * (0.55 + b * 0.9);
        sx = r; sz2 = r; sy = h;
        // A degree or two off plumb. Columns cool against each other, not level.
        rotX = (c - 0.5) * 0.09;
        rotZ = (d - 0.5) * 0.09;
        sink = 0.4;
        break;
      }
      case 'shards': {
        const w = (sz.wMin ?? 0.4) + b * ((sz.wMax ?? 1.5) - (sz.wMin ?? 0.4));
        sx = w; sz2 = w;
        sy = (sz.hMin ?? 1) + c * ((sz.hMax ?? 4) - (sz.hMin ?? 1));
        // Shards lean hard - they are shatter, not growth.
        rotX = (a - 0.5) * 0.75;
        rotZ = (d - 0.5) * 0.75;
        sink = sy * 0.18;
        break;
      }
      case 'boulders': {
        const r = (sz.rMin ?? 0.6) + a * ((sz.rMax ?? 3) - (sz.rMin ?? 0.6));
        sx = r * (0.7 + b * 0.6);
        sy = r * (0.6 + c * 0.7);
        sz2 = r * (0.7 + d * 0.6);
        rotX = a * Math.PI;
        rotZ = c * Math.PI;
        // Half-buried. An ejecta block resting exactly on the surface reads as
        // a prop dropped on the terrain, which is what it is.
        sink = sy * 0.42;
        break;
      }
      default: { // vents
        const r = (sz.rMin ?? 0.8) + a * ((sz.rMax ?? 2.5) - (sz.rMin ?? 0.8));
        sx = r; sz2 = r;
        sy = r * (0.5 + b * 0.7);
        sink = sy * 0.25;
        break;
      }
    }

    _e.set(rotX, a * Math.PI * 2, rotZ);
    _q.setFromEuler(_e);
    _p.set(pt.x, pt.y - sink, pt.z);
    _s.set(sx, sy, sz2);
    _m.compose(_p, _q, _s);
    mesh.setMatrixAt(i, _m);
    mesh.setColorAt(i, tintOf(spec.tint ?? [0x888888], b));

    if (spec.collide && ctx.physics) {
      /* An axis-aligned box round the instance, not the oriented hull. The
       * instances are within a few degrees of plumb, and a box is what gives
       * the climb probe one consistent normal per face - which is why every
       * structure in Citadel is a box too.
       *
       * 0.8 of the circumradius: a hexagonal prism measures 0.866r flat-to-flat
       * and r corner-to-corner, so this is between the two and slightly under
       * the corner. Deliberately the under side - the visible geometry is the
       * authority on where a wall is, and a collider wider than the thing it
       * stands for is an invisible wall, which is the worse of the two errors. */
      const hx = Math.max(sx, sz2) * 0.8;
      const hy = sy * 0.5;
      ctx.track(ctx.physics.addBox(pt.x, pt.y - sink + hy, pt.z, hx, hy, hx));
      colliders++;
    }
  }

  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  mesh.computeBoundingSphere();
  ctx.group.add(mesh);

  return { mesh, geo, placed: res.points.length, requested: res.requested, colliders, points: res.points, rejects: res.rejects };
}

/* ================================================================== */
/* Steam                                                               */
/* ================================================================== */

const PLUME_VERT = /* glsl */`
  /* aOrigin, and NOT instanceMatrix.
   *
   * Three declares "attribute mat4 instanceMatrix" only for an InstancedMesh;
   * an InstancedBufferGeometry on a plain Mesh gets no such declaration, so the
   * first version of this shader referenced an attribute that did not exist. It
   * cost nothing at build time and the whole steam field was simply absent from
   * the frame. A puff needs a POSITION, not a transform, so this is the honest
   * attribute anyway.
   * (No backticks in here: this string is a template literal.) */
  attribute vec3 aOrigin;
  attribute vec4 aPuff;      // x,z jitter, rise speed, phase
  attribute float aScale;
  uniform float uTime;
  uniform float uHeight;
  varying float vFade;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    /* Life runs 0..1 and wraps. Everything about a puff - its height, its
     * width, its opacity - is a function of that one number, so the whole
     * field animates with no CPU work and no per-frame allocation. */
    float life = fract(uTime * aPuff.z + aPuff.w);
    float rise = life * uHeight * aScale;
    // Wide at the top, narrow at the mouth: steam entrains air as it climbs.
    float wide = aScale * (1.2 + life * 5.0);
    vFade = sin(life * 3.14159) * (1.0 - life * 0.35);

    vec4 centre = vec4(aOrigin, 1.0);
    centre.xyz += vec3(aPuff.x * life * 6.0, rise, aPuff.y * life * 6.0);
    vec4 mv = modelViewMatrix * centre;
    // Billboard: the quad's own XY is applied in view space, so it always faces
    // the camera without a per-frame CPU pass over every puff.
    mv.xy += position.xy * wide;
    gl_Position = projectionMatrix * mv;
  }
`;

const PLUME_FRAG = /* glsl */`
  uniform vec3 uColor;
  uniform float uOpacity;
  varying float vFade;
  varying vec2 vUv;
  void main() {
    vec2 d = vUv - 0.5;
    float r = sqrt(dot(d, d)) * 2.0;
    /* pow 2.6 on the radial falloff, not a squared quadratic. The first version
     * gave every puff a hard bright core and the vent fields read as popcorn
     * stuck to the ground; steam has no core, only an edge that is slightly
     * less transparent than the middle of the next one. */
    float a = pow(clamp(1.0 - r, 0.0, 1.0), 2.6) * vFade * uOpacity;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
  }
`;

/**
 * Steam over a set of vents.
 *
 * One `InstancedMesh` of camera-facing quads, animated entirely in the vertex
 * shader off `uTime` and a per-instance phase. The CPU touches it once at build
 * and then only to write a float per frame, which is what makes sixty plumes
 * affordable at all - and is the house rule about never allocating inside a
 * frame handler expressed as a design rather than as a discipline.
 *
 * @param {Array<{x:number,y:number,z:number,rnd:number}>} vents
 * @param {{ perVent:number, height:number, color:number, opacity:number, scale:number }} o
 */
export function buildPlumes(vents, o) {
  const perVent = o.perVent ?? 5;
  const n = Math.max(1, vents.length * perVent);
  const geo = new THREE.InstancedBufferGeometry();
  const quad = new THREE.PlaneGeometry(1, 1);
  geo.index = quad.index;
  geo.attributes.position = quad.attributes.position;
  geo.attributes.uv = quad.attributes.uv;
  quad.dispose();

  const puff = new Float32Array(n * 4);
  const scale = new Float32Array(n);
  const origin = new Float32Array(n * 3);
  let k = 0;
  for (const v of vents) {
    for (let i = 0; i < perVent; i++) {
      const r = ((v.rnd * 977 + i * 131.7) % 1);
      const r2 = ((v.rnd * 313 + i * 57.3) % 1);
      puff[k * 4] = (r - 0.5) * 0.9;
      puff[k * 4 + 1] = (r2 - 0.5) * 0.9;
      puff[k * 4 + 2] = 0.05 + r * 0.06;          // rise rate, cycles/second
      puff[k * 4 + 3] = i / perVent + r2 * 0.15;  // phase, so a vent is a column
      scale[k] = 0.7 + r2 * 0.8;
      origin[k * 3] = v.x;
      origin[k * 3 + 1] = v.y + 0.4;
      origin[k * 3 + 2] = v.z;
      k++;
    }
  }
  geo.setAttribute('aPuff', new THREE.InstancedBufferAttribute(puff, 4));
  geo.setAttribute('aScale', new THREE.InstancedBufferAttribute(scale, 1));
  geo.setAttribute('aOrigin', new THREE.InstancedBufferAttribute(origin, 3));
  geo.instanceCount = k;

  const mat = new THREE.ShaderMaterial({
    name: 'planet.plume',
    uniforms: {
      uTime: { value: 0 },
      uHeight: { value: o.height ?? 14 },
      uColor: { value: new THREE.Color(o.color ?? 0xc8b0a0) },
      uOpacity: { value: o.opacity ?? 0.3 },
    },
    vertexShader: PLUME_VERT,
    fragmentShader: PLUME_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.NormalBlending,
  });

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'planet:plumes';
  /* Never culled and drawn late. The bounding sphere of an instanced geometry
   * whose instances are moved in the shader is a lie, and a plume that vanishes
   * because the renderer believed it is the classic version of this bug. */
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return { mesh, material: mat, geometry: geo, count: k };
}
