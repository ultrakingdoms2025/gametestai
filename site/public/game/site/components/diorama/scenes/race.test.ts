import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { createRaceScene } from './race';
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

describe('race scene', () => {
  it('has id "race"', () => {
    expect(createRaceScene().id).toBe('race');
  });

  it('disposes every geometry and material it builds (no leaks)', () => {
    const ctx = makeTestCtx();
    const geoSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const matSpy = vi.spyOn(THREE.Material.prototype, 'dispose');
    const scene = createRaceScene();
    scene.build(ctx);
    scene.dispose();
    // Exact counts of the resources race.ts currently tracks via track():
    // 12 geometries (terrain, track ribbon, center line, shared pylon/post
    // cylinder, gantry crossbeam, gantry checker plane, city building box,
    // city window plane, car body, car cabin wedge, car glow shell, spark
    // field) and 11 materials (terrain, asphalt, center line, steel,
    // building, window, two checker colors, car body, car glow, spark).
    // Update these numbers if the scene's tracked resources change — that's
    // the point of pinning them exactly.
    expect(geoSpy.mock.calls.length).toBe(12);
    expect(matSpy.mock.calls.length).toBe(11);
    expect(ctx.scene.children.length).toBe(0);
    geoSpy.mockRestore();
    matSpy.mockRestore();
  });

  it('update is deterministic at a fixed progress', () => {
    const s1 = createRaceScene();
    const c1 = makeTestCtx();
    s1.build(c1);
    const s2 = createRaceScene();
    const c2 = makeTestCtx();
    s2.build(c2);
    s1.update(0, 0.5, true);
    s2.update(0, 0.5, true);
    expect(c1.camera.position.toArray()).toEqual(c2.camera.position.toArray());
    expect(c1.camera.quaternion.toArray()).toEqual(c2.camera.quaternion.toArray());
  });

  it('moves the camera as progress advances, and ignores updates when inactive', () => {
    const s = createRaceScene();
    const c = makeTestCtx();
    s.build(c);
    s.update(0, 0, true);
    const start = c.camera.position.toArray();
    s.update(0, 1, true);
    const end = c.camera.position.toArray();
    expect(end).not.toEqual(start); // high overhead -> low near the gantry, banked descent actually happened
    s.update(0.016, 0.25, false); // inactive → early return, camera untouched
    expect(c.camera.position.toArray()).toEqual(end);
  });

  it('spark-field layout is deterministic: two independently built scenes match', () => {
    const s1 = createRaceScene();
    const c1 = makeTestCtx();
    s1.build(c1);
    const s2 = createRaceScene();
    const c2 = makeTestCtx();
    s2.build(c2);

    const points1 = findPoints(c1.scene);
    const points2 = findPoints(c2.scene);
    expect(points1.length).toBeGreaterThan(0);
    expect(points2.length).toBe(points1.length);

    // Only Points object in the graph is the spark/dust field.
    const pos1 = Array.from(
      (points1[0].geometry.attributes.position as THREE.BufferAttribute).array,
    );
    const pos2 = Array.from(
      (points2[0].geometry.attributes.position as THREE.BufferAttribute).array,
    );
    expect(pos1).toEqual(pos2);
  });

  it("setQuality('low') hides the detail group and shrinks the spark drawRange", () => {
    const s = createRaceScene();
    const c = makeTestCtx('high');
    s.build(c);

    // At 'high', every group in the scene graph (root, detail, the car) is visible.
    const groupsBefore = findGroups(c.scene);
    expect(groupsBefore.length).toBeGreaterThan(0);
    expect(groupsBefore.filter((g) => !g.visible)).toHaveLength(0);

    const points = findPoints(c.scene);
    const sparksHighRange = points[0].geometry.drawRange.count;

    s.setQuality('low');

    // Exactly one group — the culled city-window/checker detail layer — goes invisible on 'low'.
    const groupsAfter = findGroups(c.scene);
    expect(groupsAfter.filter((g) => !g.visible)).toHaveLength(1);

    const sparksLowRange = points[0].geometry.drawRange.count;
    expect(sparksLowRange).toBeLessThan(sparksHighRange);
  });

  it('the car advances along the track over time as dt accumulates', () => {
    const s = createRaceScene();
    const c = makeTestCtx();
    s.build(c);

    let car: THREE.Object3D | null = null;
    c.scene.traverse((obj) => {
      if (obj.name === 'car') car = obj;
    });
    expect(car).not.toBeNull();

    // Fixed progress, only dt varies — this is ambient drift, not camera motion.
    s.update(0.5, 0.3, true);
    const pos1 = car!.position.toArray();
    s.update(0.5, 0.3, true);
    const pos2 = car!.position.toArray();
    expect(pos2).not.toEqual(pos1);
  });
});
