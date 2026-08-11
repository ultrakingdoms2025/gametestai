import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { createMedievalScene } from './medieval';
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

describe('medieval scene', () => {
  it('has id "medieval"', () => {
    expect(createMedievalScene().id).toBe('medieval');
  });

  it('disposes every geometry and material it builds (no leaks)', () => {
    const ctx = makeTestCtx();
    const geoSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const matSpy = vi.spyOn(THREE.Material.prototype, 'dispose');
    const scene = createMedievalScene();
    scene.build(ctx);
    scene.dispose();
    // Exact counts of the resources medieval.ts currently tracks via track():
    // 8 geometries (ground, lake, shared box, shared roof cone, tower, shared
    // window plane, pine cone, embers) and 7 materials (ground, lake, hull,
    // roof, window, pine, embers). Update these numbers if the scene's
    // tracked resources change — that's the point of pinning them exactly.
    expect(geoSpy.mock.calls.length).toBe(8);
    expect(matSpy.mock.calls.length).toBe(7);
    expect(ctx.scene.children.length).toBe(0);
    geoSpy.mockRestore();
    matSpy.mockRestore();
  });

  it('update is deterministic at a fixed progress', () => {
    const s1 = createMedievalScene();
    const c1 = makeTestCtx();
    s1.build(c1);
    const s2 = createMedievalScene();
    const c2 = makeTestCtx();
    s2.build(c2);
    s1.update(0, 0.5, true);
    s2.update(0, 0.5, true);
    expect(c1.camera.position.toArray()).toEqual(c2.camera.position.toArray());
    expect(c1.camera.quaternion.toArray()).toEqual(c2.camera.quaternion.toArray());
  });

  it('moves the camera as progress advances, and ignores updates when inactive', () => {
    const s = createMedievalScene();
    const c = makeTestCtx();
    s.build(c);
    s.update(0, 0, true);
    const start = c.camera.position.toArray();
    s.update(0, 1, true);
    const end = c.camera.position.toArray();
    expect(end).not.toEqual(start); // descent + glide toward the town gates actually happened
    s.update(0.016, 0.25, false); // inactive → early return, camera untouched
    expect(c.camera.position.toArray()).toEqual(end);
  });

  it('ember layout is deterministic: two independently built scenes match', () => {
    const s1 = createMedievalScene();
    const c1 = makeTestCtx();
    s1.build(c1);
    const s2 = createMedievalScene();
    const c2 = makeTestCtx();
    s2.build(c2);

    const points1 = findPoints(c1.scene);
    const points2 = findPoints(c2.scene);
    expect(points1.length).toBeGreaterThan(0);
    expect(points2.length).toBe(points1.length);

    // Only Points object in the graph is the ember field.
    const pos1 = Array.from(
      (points1[0].geometry.attributes.position as THREE.BufferAttribute).array,
    );
    const pos2 = Array.from(
      (points2[0].geometry.attributes.position as THREE.BufferAttribute).array,
    );
    expect(pos1).toEqual(pos2);
  });

  it("setQuality('low') hides the detail group and shrinks the ember drawRange", () => {
    const s = createMedievalScene();
    const c = makeTestCtx('high');
    s.build(c);

    // At 'high', every group in the scene graph (root, town, castle, detail) is visible.
    const groupsBefore = findGroups(c.scene);
    expect(groupsBefore.length).toBeGreaterThan(0);
    expect(groupsBefore.filter((g) => !g.visible)).toHaveLength(0);

    const points = findPoints(c.scene);
    const embersHighRange = points[0].geometry.drawRange.count;

    s.setQuality('low');

    // Exactly one group — the culled window/beacon detail layer — goes invisible on 'low'.
    const groupsAfter = findGroups(c.scene);
    expect(groupsAfter.filter((g) => !g.visible)).toHaveLength(1);

    const embersLowRange = points[0].geometry.drawRange.count;
    expect(embersLowRange).toBeLessThan(embersHighRange);
  });
});
