import { buildStation, THREE } from './tests/world-kit.mjs';
const t0 = Date.now();
const { world } = await buildStation();
world.group.updateMatrixWorld(true);

/* Every instanced prop, as a world AABB plus its identity. */
const props = [];
const m4 = new THREE.Matrix4();
world.group.traverse((o) => {
  if (!o.isInstancedMesh || !o.geometry || !o.visible) return;
  const mat = Array.isArray(o.material) ? o.material[0] : o.material;
  if (!mat || mat.transparent || mat.depthWrite === false) return;
  if (!o.geometry.boundingBox) o.geometry.computeBoundingBox();
  const gb = o.geometry.boundingBox;
  const s = gb.getSize(new THREE.Vector3());
  if (s.x > 12 || s.y > 12 || s.z > 12) return;          // not a prop
  if (s.x < 0.25 && s.y < 0.25 && s.z < 0.25) return;    // too small to read
  for (let i = 0; i < o.count; i++) {
    o.getMatrixAt(i, m4);
    const b = gb.clone().applyMatrix4(m4).applyMatrix4(o.matrixWorld);
    if (!Number.isFinite(b.min.x)) continue;
    props.push({ mesh: o, i, b, c: b.getCenter(new THREE.Vector3()), s: b.getSize(new THREE.Vector3()) });
  }
});
console.log(`${props.length} prop instances (${((Date.now()-t0)/1000).toFixed(1)}s to build)`);
