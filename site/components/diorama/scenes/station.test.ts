import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { createStationScene } from './station';
import { makeTestCtx } from '../testCtx';

describe('station scene', () => {
  it('has id "station"', () => {
    expect(createStationScene().id).toBe('station');
  });

  it('disposes every geometry and material it builds (no leaks)', () => {
    const ctx = makeTestCtx();
    const geoSpy = vi.spyOn(THREE.BufferGeometry.prototype, 'dispose');
    const matSpy = vi.spyOn(THREE.Material.prototype, 'dispose');
    const scene = createStationScene();
    scene.build(ctx);
    scene.dispose();
    // The scene builds at least: planet, atmosphere, ring, glow ring, hub core,
    // window band, blocks, gantries, pads, antenna, tip, stars, traffic — so a
    // handful of geometries and materials MUST have been disposed, and the root
    // group MUST have been removed from the scene graph.
    expect(geoSpy.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(matSpy.mock.calls.length).toBeGreaterThanOrEqual(6);
    expect(ctx.scene.children.length).toBe(0);
    geoSpy.mockRestore();
    matSpy.mockRestore();
  });

  it('update is deterministic at a fixed progress', () => {
    const s1 = createStationScene();
    const c1 = makeTestCtx();
    s1.build(c1);
    const s2 = createStationScene();
    const c2 = makeTestCtx();
    s2.build(c2);
    s1.update(0, 0.5, true);
    s2.update(0, 0.5, true);
    expect(c1.camera.position.toArray()).toEqual(c2.camera.position.toArray());
    expect(c1.camera.quaternion.toArray()).toEqual(c2.camera.quaternion.toArray());
  });

  it('moves the camera as progress advances, and ignores updates when inactive', () => {
    const s = createStationScene();
    const c = makeTestCtx();
    s.build(c);
    s.update(0, 0, true);
    const start = c.camera.position.toArray();
    s.update(0, 1, true);
    const end = c.camera.position.toArray();
    expect(end).not.toEqual(start); // dolly-in + orbit actually happened
    s.update(0.016, 0.25, false); // inactive → early return, camera untouched
    expect(c.camera.position.toArray()).toEqual(end);
  });
});
