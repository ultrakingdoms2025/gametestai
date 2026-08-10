import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { createVerdantCoilScene } from './verdantCoil';
import { makeTestCtx } from '../testCtx';

/** Every THREE.Points object anywhere in the scene graph, in traversal order. */
function findPoints(scene: THREE.Scene): THREE.Points[] {
  const found: THREE.Points[] = [];
  scene.traverse((obj) => {
    if (obj instanceof THREE.Points) found.push(obj);
  });
  return found;
}

/** Every THREE.Group object anywhere in the scene graph, in traversal order. */
function findGroups(scene: THREE.Scene): THREE.Group[] {
  const found: THREE.Group[] = [];
  scene.traverse((obj) => {
    if (obj instanceof THREE.Group) found.push(obj);
  });
  return found;
}

/** Every THREE.InstancedMesh anywhere in the scene graph, in traversal order. */
function findInstancedMeshes(scene: THREE.Scene): THREE.InstancedMesh[] {
  const found: THREE.InstancedMesh[] = [];
  scene.traverse((obj) => {
    if (obj instanceof THREE.InstancedMesh) found.push(obj);
  });
  return found;
}

describe('verdant coil scene', () => {
  it('has id "maze" (the world id, not the display name)', () => {
    expect(createVerdantCoilScene().id).toBe('maze');
  });

  it('disposes every geometry and material it builds (no leaks)', () => {
    const ctx = makeTestCtx();
    const geoSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const matSpy = vi.spyOn(THREE.Material.prototype, 'dispose');
    const scene = createVerdantCoilScene();
    scene.build(ctx);
    scene.dispose();
    // Exact counts of the resources verdantCoil.ts currently tracks via
    // track(): 8 geometries (ground, outer ring, ring glow, shared hedge
    // box, lantern pole, lantern bulb, lantern glow, spore field) and 10
    // materials (ground, ring, ring glow, 3 independent hedge-layout
    // materials for the cross-dissolve, lantern pole, lantern bulb, lantern
    // glow, spore field). Update these numbers if the scene's tracked
    // resources change — that's the point of pinning them exactly.
    expect(geoSpy.mock.calls.length).toBe(8);
    expect(matSpy.mock.calls.length).toBe(10);
    expect(ctx.scene.children.length).toBe(0);
    geoSpy.mockRestore();
    matSpy.mockRestore();
  });

  it('update is deterministic at a fixed progress', () => {
    const s1 = createVerdantCoilScene();
    const c1 = makeTestCtx();
    s1.build(c1);
    const s2 = createVerdantCoilScene();
    const c2 = makeTestCtx();
    s2.build(c2);
    s1.update(0, 0.5, true);
    s2.update(0, 0.5, true);
    expect(c1.camera.position.toArray()).toEqual(c2.camera.position.toArray());
    expect(c1.camera.quaternion.toArray()).toEqual(c2.camera.quaternion.toArray());
  });

  it('moves the camera as progress advances, and ignores updates when inactive', () => {
    const s = createVerdantCoilScene();
    const c = makeTestCtx();
    s.build(c);
    s.update(0, 0, true);
    const start = c.camera.position.toArray();
    s.update(0, 1, true);
    const end = c.camera.position.toArray();
    expect(end).not.toEqual(start); // overhead -> low spiral descent near the lantern actually happened
    s.update(0.016, 0.25, false); // inactive → early return, camera untouched
    expect(c.camera.position.toArray()).toEqual(end);
  });

  it('spore-field layout is deterministic: two independently built scenes match', () => {
    const s1 = createVerdantCoilScene();
    const c1 = makeTestCtx();
    s1.build(c1);
    const s2 = createVerdantCoilScene();
    const c2 = makeTestCtx();
    s2.build(c2);

    const points1 = findPoints(c1.scene);
    const points2 = findPoints(c2.scene);
    expect(points1.length).toBeGreaterThan(0);
    expect(points2.length).toBe(points1.length);

    // Only Points object in the graph is the spore field.
    const pos1 = Array.from(
      (points1[0].geometry.attributes.position as THREE.BufferAttribute).array,
    );
    const pos2 = Array.from(
      (points2[0].geometry.attributes.position as THREE.BufferAttribute).array,
    );
    expect(pos1).toEqual(pos2);
  });

  it("setQuality('low') hides the detail group and shrinks the spore drawRange", () => {
    const s = createVerdantCoilScene();
    const c = makeTestCtx('high');
    s.build(c);

    // At 'high', every group in the scene graph (root, detail) is visible.
    const groupsBefore = findGroups(c.scene);
    expect(groupsBefore.length).toBeGreaterThan(0);
    expect(groupsBefore.filter((g) => !g.visible)).toHaveLength(0);

    const points = findPoints(c.scene);
    const sporesHighRange = points[0].geometry.drawRange.count;

    s.setQuality('low');

    // Exactly one group — the culled ring-glow/lantern-glow detail layer — goes invisible on 'low'.
    const groupsAfter = findGroups(c.scene);
    expect(groupsAfter.filter((g) => !g.visible)).toHaveLength(1);

    const sporesLowRange = points[0].geometry.drawRange.count;
    expect(sporesLowRange).toBeLessThan(sporesHighRange);
  });

  it('THE SIGNATURE: the maze re-threads — hedge-layout opacity differs between progress 0.2 and 0.8', () => {
    const s = createVerdantCoilScene();
    const c = makeTestCtx();
    s.build(c);

    const hedgeMeshes = findInstancedMeshes(c.scene);
    expect(hedgeMeshes.length).toBe(3); // layoutA, layoutB, layoutC

    s.update(0, 0.2, true);
    const opacitiesAt02 = hedgeMeshes.map((m) => (m.material as THREE.Material).opacity);

    s.update(0, 0.8, true);
    const opacitiesAt08 = hedgeMeshes.map((m) => (m.material as THREE.Material).opacity);

    // The maze has visibly re-threaded to a different seeded layout: at 0.2
    // layout A is fully opaque and layout C fully transparent; by 0.8 the
    // cross-dissolve has finished and the reverse holds.
    expect(opacitiesAt08).not.toEqual(opacitiesAt02);
    expect(opacitiesAt02[0]).toBeCloseTo(1, 5);
    expect(opacitiesAt02[2]).toBeCloseTo(0, 5);
    expect(opacitiesAt08[0]).toBeCloseTo(0, 5);
    expect(opacitiesAt08[2]).toBeCloseTo(1, 5);

    // Each layout's instance count is fixed at build time from its own
    // seeded carve and never changes post-build — only opacity animates.
    for (const m of hedgeMeshes) expect(m.count).toBeGreaterThan(0);
  });
});
