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

/**
 * Triangles and visible instances in a `BatchedMesh`, counted EXACTLY.
 *
 * This used to return 1 and say so: "three exposes no public count, so fall
 * back to 1 rather than guess". The comment was honest and the number was
 * still wrong in a way that mattered — `obj.geometry` on a BatchedMesh is the
 * RESERVED buffer shared by every batched geometry, so the walker was
 * reporting one copy of the whole reservation. The maze is the world built on
 * this class, and its headline triangle number therefore never included the
 * static maze at all. A measuring instrument reporting a confident wrong
 * number is the thing this repository keeps paying for.
 *
 * three r185 does expose enough to be exact: `instanceCount`, `getVisibleAt`,
 * `getGeometryIdAt` and `getGeometryRangeAt`.
 *
 * Instance ids are SPARSE — `deleteInstance` returns an id to a free list and
 * `instanceCount` is active-count, not a high-water mark, so iterating
 * `0..instanceCount-1` walks off the end of a batch that has ever deleted one.
 * Iterate to `maxInstanceCount` and stop once `instanceCount` live ids have
 * been seen; the accessors throw on a dead id, which is what the catch is for.
 *
 * @returns {{tris: number, instances: number}|null} null when this is not a
 *   BatchedMesh, or the build is too old to answer, in which case the caller
 *   keeps the old arithmetic rather than inventing a number.
 */
function batchedCount(obj) {
  if (!obj.isBatchedMesh) return null;
  const active = obj.instanceCount;
  if (!Number.isFinite(active)) return null;
  const max = Number.isFinite(obj.maxInstanceCount) ? obj.maxInstanceCount : active;

  let tris = 0;
  let instances = 0;
  let seen = 0;
  const range = {};

  for (let i = 0; i < max && seen < active; i++) {
    let visible;
    let gid;
    try {
      visible = obj.getVisibleAt(i);
      gid = obj.getGeometryIdAt(i);
    } catch {
      continue;
    }
    seen += 1;
    if (!visible || !(gid >= 0)) continue;
    try {
      obj.getGeometryRangeAt(gid, range);
    } catch {
      continue;
    }
    const c = range.indexCount > 0 ? range.indexCount : range.vertexCount;
    if (!Number.isFinite(c)) continue;
    tris += Math.max(0, Math.floor(c / 3));
    instances += 1;
  }
  return { tris, instances };
}

/** How many copies of the geometry a single object submits. */
function instanceCount(obj) {
  if (obj.isInstancedMesh) return obj.count;
  /* BatchedMesh is handled exactly by batchedCount() above; a caller that
   * reaches here for one is counting a single submission. */
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
        const batched = batchedCount(obj);
        const tris = batched
          ? batched.tris
          : geometryTriangles(obj.geometry) * instanceCount(obj);
        const submissions = batched ? batched.instances : instanceCount(obj);
        const inFrustum = obj.frustumCulled === false || _frustum.intersectsObject(obj);
        if (inFrustum) {
          result.triangles += tris;
          result.objects += 1;
          result.instances += submissions;
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

/**
 * What a set of objects WOULD draw in this frustum, whether or not they are
 * visible right now.
 *
 * The counterpart `walkWorldTriangles` cannot provide: it stops at an invisible
 * object by design, so once something is hidden it can no longer say how much
 * hiding it was worth. That is exactly the question an ablation has to answer -
 * "did switching this off remove anything the camera could see?" - and without
 * it `--ablate` can only report how many meshes it touched, which is what let
 * an ablation that changed nothing at all read as evidence.
 *
 * Ancestors' visibility is ignored too, on purpose: the objects handed in are
 * the ones the caller hid, and their parents are not the subject.
 *
 * @param {Iterable<import('three').Object3D>} objects
 * @param {import('three').Camera} camera
 * @returns {{triangles:number, objects:number, culledObjects:number}}
 */
export function drawnTrianglesOf(objects, camera) {
  const out = { triangles: 0, objects: 0, culledObjects: 0 };
  if (!objects || !camera) return out;
  camera.updateMatrixWorld();
  _proj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  _frustum.setFromProjectionMatrix(_proj);
  for (const obj of objects) {
    if (!obj?.isMesh) continue;
    obj.updateWorldMatrix(true, false);
    if (camera.layers && !obj.layers.test(camera.layers)) continue;
    const tris = geometryTriangles(obj.geometry) * instanceCount(obj);
    if (obj.frustumCulled === false || _frustum.intersectsObject(obj)) {
      out.triangles += tris;
      out.objects += 1;
    } else {
      out.culledObjects += 1;
    }
  }
  return out;
}

export default walkWorldTriangles;
