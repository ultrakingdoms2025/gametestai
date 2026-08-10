import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { createSportsScene } from './sports';
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

describe('sports scene', () => {
  it('has id "sports"', () => {
    expect(createSportsScene().id).toBe('sports');
  });

  it('disposes every geometry and material it builds (no leaks)', () => {
    const ctx = makeTestCtx();
    const geoSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const matSpy = vi.spyOn(THREE.Material.prototype, 'dispose');
    const scene = createSportsScene();
    scene.build(ctx);
    scene.dispose();
    // Exact counts of the resources sports.ts currently tracks via track():
    // 12 geometries (bowl tier torus, trim ring torus, crowd points, track
    // ring, lane ring, infield circle, pylon shaft, pylon panel, light
    // cone, pool plane, half-pipe cylinder, snow ramp box) and 12 materials
    // (bowl, trim, crowd, track, lane, infield, pylon, panel, cone, pool,
    // half-pipe, snow). Update these numbers if the scene's tracked
    // resources change — that's the point of pinning them exactly.
    expect(geoSpy.mock.calls.length).toBe(12);
    expect(matSpy.mock.calls.length).toBe(12);
    expect(ctx.scene.children.length).toBe(0);
    geoSpy.mockRestore();
    matSpy.mockRestore();
  });

  it('update is deterministic at a fixed progress', () => {
    const s1 = createSportsScene();
    const c1 = makeTestCtx();
    s1.build(c1);
    const s2 = createSportsScene();
    const c2 = makeTestCtx();
    s2.build(c2);
    s1.update(0, 0.5, true);
    s2.update(0, 0.5, true);
    expect(c1.camera.position.toArray()).toEqual(c2.camera.position.toArray());
    expect(c1.camera.quaternion.toArray()).toEqual(c2.camera.quaternion.toArray());
  });

  it('moves the camera as progress advances, and ignores updates when inactive', () => {
    const s = createSportsScene();
    const c = makeTestCtx();
    s.build(c);
    s.update(0, 0, true);
    const start = c.camera.position.toArray();
    s.update(0, 1, true);
    const end = c.camera.position.toArray();
    expect(end).not.toEqual(start); // descend + sweep around the bowl actually happened
    s.update(0.016, 0.25, false); // inactive → early return, camera untouched
    expect(c.camera.position.toArray()).toEqual(end);
  });

  it('crowd layout is deterministic: two independently built scenes match', () => {
    const s1 = createSportsScene();
    const c1 = makeTestCtx();
    s1.build(c1);
    const s2 = createSportsScene();
    const c2 = makeTestCtx();
    s2.build(c2);

    const points1 = findPoints(c1.scene);
    const points2 = findPoints(c2.scene);
    expect(points1.length).toBeGreaterThan(0);
    expect(points2.length).toBe(points1.length);

    // Only Points object in the graph is the crowd-shimmer field.
    const pos1 = Array.from(
      (points1[0].geometry.attributes.position as THREE.BufferAttribute).array,
    );
    const pos2 = Array.from(
      (points2[0].geometry.attributes.position as THREE.BufferAttribute).array,
    );
    expect(pos1).toEqual(pos2);
  });

  it("setQuality('low') hides the detail group and shrinks the crowd drawRange", () => {
    const s = createSportsScene();
    const c = makeTestCtx('high');
    s.build(c);

    // At 'high', every group in the scene graph (root, detail, floodlight aims) is visible.
    const groupsBefore = findGroups(c.scene);
    expect(groupsBefore.length).toBeGreaterThan(0);
    expect(groupsBefore.filter((g) => !g.visible)).toHaveLength(0);

    const points = findPoints(c.scene);
    const crowdHighRange = points[0].geometry.drawRange.count;

    s.setQuality('low');

    // Exactly one group — the culled trim/lane/panel/cone detail layer — goes invisible on 'low'.
    const groupsAfter = findGroups(c.scene);
    expect(groupsAfter.filter((g) => !g.visible)).toHaveLength(1);

    const crowdLowRange = points[0].geometry.drawRange.count;
    expect(crowdLowRange).toBeLessThan(crowdHighRange);
  });
});
