/**
 * A deterministic triangle count for whatever the camera can actually see.
 *
 * WHY THIS EXISTS. `renderer.info.render.triangles` is the sum over every pass
 * the composer ran, and two of those passes are not stable between page loads:
 * the shadow pass covers whatever happens to be inside the sun's frustum (which
 * is aimed at the PLAYER, not the camera - see Harness.look) and GTAO's depth
 * prepass follows the render list. Measured on the station plaza, frame totals
 * moved 10-13% between loads of the *same* framing with nothing changed. Two
 * separate agents spent an afternoon each concluding a change had made things
 * worse when all they had measured was that variance, and both of them ended up
 * hand-writing some version of the walk below to get a number that held still.
 *
 * So it lives here now. This counts the world group's geometry once, against
 * one frustum, with no passes involved - it reproduces bit-identically across
 * loads because nothing about it depends on what the renderer chose to do.
 *
 * It is NOT a substitute for `renderer.info`: it cannot tell you what a frame
 * costs, only what is in front of the camera. Use it for A/Bs where the
 * question is "did this change what is drawn", and `renderer.info` when the
 * question is "what does the frame cost". `Harness.stats()` labels both.
 *
 * Dev-only: imported solely by src/dev/Harness.js, which only loads under
 * ?dev=1.
 */

import * as THREE from 'three';

const _proj = new THREE.Matrix4();
const _frustum = new THREE.Frustum();

/**
 * Triangles in one geometry, counting the way a draw call does.
 *
 * `drawRange` is honoured because the maze's batched hedges publish a full
 * index buffer and then draw a prefix of it - counting the buffer would report
 * geometry that is never submitted.
 */
function geometryTriangles(geo) {
  if (!geo) return 0;
  const index = geo.index;
  const pos = geo.attributes?.position;
  const available = index ? index.count : (pos ? pos.count : 0);
  const range = geo.drawRange;
  const count = range && Number.isFinite(range.count)
    ? Math.min(available - (range.start || 0), range.count)
    : available;
  return Math.max(0, Math.floor(count / 3));
}

/** How many copies of the geometry a single object submits. */
function instanceCount(obj) {
  if (obj.isInstancedMesh) return obj.count;
  // BatchedMesh reports its own per-instance visibility; without walking its
  // internals the honest answer is "one geometry's worth per drawn instance",
  // and three exposes no public count, so fall back to 1 rather than guess.
  return 1;
}

/** Nearest ancestor (or self) carrying a name, so the breakdown is readable. */
function nameOf(obj, root) {
  let n = obj;
  while (n && n !== root?.parent) {
    if (n.name) return n.name;
    n = n.parent;
  }
  return '(unnamed)';
}

function materialKey(mat) {
  if (!mat) return '(none)';
  if (Array.isArray(mat)) return mat.map(materialKey).join('+');
  return mat.name || mat.type || '(material)';
}

/** Accumulate into a keyed bucket. */
function bump(map, key, triangles) {
  const e = map.get(key);
  if (e) {
    e.triangles += triangles;
    e.objects += 1;
  } else {
    map.set(key, { key, triangles, objects: 1 });
  }
}

/**
 * Sorted, so two runs that see the same geometry emit byte-identical output.
 * Triangles descending, then key, because a tie broken by insertion order is a
 * tie broken by traversal order, which is exactly the non-determinism this
 * module exists to remove.
 */
function sortBuckets(map) {
  return [...map.values()].sort((a, b) => b.triangles - a.triangles || (a.key < b.key ? -1 : 1));
}

/**
 * Walk `root` and count the triangles inside `camera`'s frustum.
 *
 * The visibility rules mirror `WebGLRenderer.projectObject`: an invisible
 * object takes its whole subtree with it, layers must intersect the camera's,
 * and `frustumCulled === false` opts an object out of the test entirely (which
 * is why sky domes and the like are counted - the renderer draws them too).
 *
 * @param {THREE.Object3D} root typically `worldManager.active.group`
 * @param {THREE.Camera} camera
 * @param {{ breakdown?: boolean }} [opts]
 */
export function walkWorldTriangles(root, camera, opts = {}) {
  const { breakdown = true } = opts;
  const result = {
    /* The point of the number: this one does not move between runs. */
    deterministic: true,
    triangles: 0,
    objects: 0,
    instances: 0,
    culledObjects: 0,
    culledTriangles: 0,
    byMaterial: [],
    byName: [],
  };
  if (!root || !camera) return result;

  root.updateMatrixWorld(true);
  camera.updateMatrixWorld();
  _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_proj);

  const byMaterial = new Map();
  const byName = new Map();

  const visit = (obj) => {
    if (!obj.visible) return;
    if (obj.isMesh) {
      const layersOk = !camera.layers || obj.layers.test(camera.layers);
      if (layersOk) {
        const tris = geometryTriangles(obj.geometry) * instanceCount(obj);
        const inFrustum = obj.frustumCulled === false || _frustum.intersectsObject(obj);
        if (inFrustum) {
          result.triangles += tris;
          result.objects += 1;
          result.instances += instanceCount(obj);
          if (breakdown) {
            bump(byMaterial, materialKey(obj.material), tris);
            bump(byName, nameOf(obj, root), tris);
          }
        } else {
          result.culledObjects += 1;
          result.culledTriangles += tris;
        }
      }
    }
    for (const child of obj.children) visit(child);
  };
  visit(root);

  if (breakdown) {
    result.byMaterial = sortBuckets(byMaterial);
    result.byName = sortBuckets(byName);
  }
  return result;
}

export default walkWorldTriangles;
