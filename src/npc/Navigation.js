import * as THREE from 'three';
import { COLLISION_LAYER } from '../physics/Physics.js';

/**
 * Per-agent steering.
 *
 * There is no navmesh in this game - worlds are generated procedurally and a
 * baked graph would go stale the moment a world changed. Instead every agent
 * runs seek/arrive against a target, then subtracts what it can see with a fan
 * of probe raycasts and pushes away from its neighbours. A stuck detector
 * catches the cases steering alone cannot solve and re-targets.
 *
 * `update()` returns a desired velocity in world space; the NPC integrates it
 * and lets `physics.resolveCapsule` do the final wall correction.
 */

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _origin = new THREE.Vector3();
const _dir = new THREE.Vector3();

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

/** Probe fan: angle from forward (radians) and reach multiplier. */
const PROBES = [
  { angle: 0, reach: 1.0, weight: 1.0 },
  { angle: 0.42, reach: 0.85, weight: 0.75 },
  { angle: -0.42, reach: 0.85, weight: 0.75 },
  { angle: 1.05, reach: 0.5, weight: 0.45 },
  { angle: -1.05, reach: 0.5, weight: 0.45 },
];

export class Navigation {
  /**
   * @param {{ physics:any, radius?:number, probeRange?:number, seed?:number }} ctx
   */
  constructor({ physics, radius = 0.36, probeRange = 2.6, seed = 1 }) {
    this.physics = physics;
    this.radius = radius;
    this.probeRange = probeRange;

    this.target = new THREE.Vector3();
    this.hasTarget = false;
    /** @type {THREE.Vector3[]} */
    this.path = [];
    this.pathIndex = 0;

    this.arriveRadius = 0.55;
    this.slowRadius = 2.4;
    this.separationRange = 1.35;

    this.desired = new THREE.Vector3();
    this.avoidance = new THREE.Vector3();
    this.arrived = false;
    this.blocked = false;

    // Stuck detection: compare travelled distance against intended distance.
    this._last = new THREE.Vector3();
    this._accum = 0;
    this._window = 0;
    this._intended = 0;
    this.isStuck = false;
    this.stuckCount = 0;
    this._detourTimer = 0;
    this._detourSign = 1;

    let s = seed >>> 0 || 7;
    this._rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    this._probePhase = Math.floor(this._rnd() * PROBES.length);
    this._probeHits = new Float32Array(PROBES.length);
    this._probeNormals = PROBES.map(() => new THREE.Vector3());
  }

  /** Steer directly at a point. Clears any waypoint path. */
  setTarget(v) {
    this.target.copy(v);
    this.hasTarget = true;
    this.path.length = 0;
    this.pathIndex = 0;
    this.arrived = false;
  }

  /** Follow a waypoint list, smoothed by line-of-sight string pulling. */
  setPath(points) {
    this.path = points ? points.map((p) => p.clone()) : [];
    this.pathIndex = 0;
    this.hasTarget = this.path.length > 0;
    if (this.hasTarget) this.target.copy(this.path[0]);
    this.arrived = false;
  }

  clear() {
    this.hasTarget = false;
    this.path.length = 0;
    this.arrived = true;
    this.desired.set(0, 0, 0);
  }

  get currentTarget() {
    return this.target;
  }

  /** True while the agent has somewhere to be. */
  get active() {
    return this.hasTarget && !this.arrived;
  }

  /**
   * Advance along a waypoint path, skipping ahead to the furthest waypoint the
   * agent can actually see. That is what turns a chain of corners into a
   * smooth diagonal instead of a series of hard turns.
   */
  _advancePath(position) {
    if (this.path.length === 0) return;
    let best = this.pathIndex;
    const limit = Math.min(this.path.length - 1, this.pathIndex + 3);
    for (let i = limit; i > this.pathIndex; i--) {
      if (this._clearLine(position, this.path[i])) {
        best = i;
        break;
      }
    }
    this.pathIndex = best;
    const wp = this.path[this.pathIndex];
    if (position.distanceToSquared(wp) < 1.1 * 1.1) {
      if (this.pathIndex < this.path.length - 1) this.pathIndex++;
    }
    this.target.copy(this.path[this.pathIndex]);
  }

  _clearLine(from, to) {
    _dir.subVectors(to, from);
    _dir.y = 0;
    const dist = _dir.length();
    if (dist < 0.05) return true;
    _dir.multiplyScalar(1 / dist);
    _origin.set(from.x, from.y + 1.0, from.z);
    const hit = this.physics.raycast(_origin, _dir, dist, COLLISION_LAYER.WORLD);
    return !hit;
  }

  /**
   * @param {number} dt
   * @param {THREE.Vector3} position feet position
   * @param {number} maxSpeed
   * @param {THREE.Vector3} forward current facing (normalised, XZ)
   * @param {Array<{position:THREE.Vector3, isDead:boolean}>} neighbours
   * @returns {THREE.Vector3} desired velocity (reused - copy if you keep it)
   */
  update(dt, position, maxSpeed, forward, neighbours) {
    this.desired.set(0, 0, 0);
    if (!this.hasTarget) {
      this._trackStuck(dt, position, 0);
      return this.desired;
    }

    this._advancePath(position);

    // --- seek / arrive ---------------------------------------------
    _v1.subVectors(this.target, position);
    _v1.y = 0;
    const dist = _v1.length();
    this.distanceToTarget = dist;
    if (dist < this.arriveRadius) {
      if (this.path.length === 0 || this.pathIndex >= this.path.length - 1) {
        this.arrived = true;
        this._trackStuck(dt, position, 0);
        return this.desired;
      }
    }
    const speed = maxSpeed * clamp(dist / this.slowRadius, 0.25, 1);
    if (dist > 1e-4) _v1.multiplyScalar(speed / dist);
    this.desired.copy(_v1);

    // --- wall avoidance --------------------------------------------
    this._probe(position, forward, dt);
    if (this.avoidance.lengthSq() > 1e-6) {
      this.desired.addScaledVector(this.avoidance, maxSpeed * 1.35);
    }

    // --- neighbour separation --------------------------------------
    if (neighbours) {
      _v2.set(0, 0, 0);
      let n = 0;
      for (const other of neighbours) {
        if (other.isDead) continue;
        _v3.subVectors(position, other.position);
        _v3.y = 0;
        const d2 = _v3.lengthSq();
        if (d2 > this.separationRange * this.separationRange || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        // Inverse falloff: contact pushes hard, near-misses barely register.
        _v2.addScaledVector(_v3, (this.separationRange - d) / (d * this.separationRange));
        n++;
      }
      if (n > 0) this.desired.addScaledVector(_v2, maxSpeed * 0.9);
    }

    // --- detour after being stuck -----------------------------------
    if (this._detourTimer > 0) {
      this._detourTimer -= dt;
      _v3.set(-this.desired.z, 0, this.desired.x).normalize();
      this.desired.addScaledVector(_v3, maxSpeed * 0.85 * this._detourSign);
    }

    const len = this.desired.length();
    if (len > maxSpeed) this.desired.multiplyScalar(maxSpeed / len);
    this._trackStuck(dt, position, len);
    return this.desired;
  }

  /**
   * Fan of raycasts ahead of the agent. Probes are staggered across frames -
   * one per frame per agent - so sixteen NPCs cost sixteen rays, not eighty.
   */
  _probe(position, forward, dt) {
    const reach = this.probeRange;
    _origin.set(position.x, position.y + 0.95, position.z);
    const fx = forward.x;
    const fz = forward.z;

    this._probePhase = (this._probePhase + 1) % PROBES.length;
    const i = this._probePhase;
    const p = PROBES[i];
    const cos = Math.cos(p.angle);
    const sin = Math.sin(p.angle);
    _dir.set(fx * cos - fz * sin, 0, fx * sin + fz * cos).normalize();
    const len = reach * p.reach;
    const hit = this.physics.raycast(_origin, _dir, len, COLLISION_LAYER.WORLD);
    if (hit) {
      this._probeHits[i] = 1 - hit.distance / len;
      this._probeNormals[i].copy(hit.normal);
      this._probeNormals[i].y = 0;
      if (this._probeNormals[i].lengthSq() < 1e-6) this._probeNormals[i].set(-_dir.x, 0, -_dir.z);
      this._probeNormals[i].normalize();
    } else {
      this._probeHits[i] = 0;
    }

    // Also probe low, where railings and kerbs live, on alternate frames.
    if (i === 0) {
      _origin.y = position.y + 0.32;
      _dir.set(fx, 0, fz);
      const low = this.physics.raycast(_origin, _dir, reach * 0.7, COLLISION_LAYER.WORLD);
      if (low) this._probeHits[0] = Math.max(this._probeHits[0], 1 - low.distance / (reach * 0.7));
    }

    this.avoidance.set(0, 0, 0);
    let strongest = 0;
    for (let k = 0; k < PROBES.length; k++) {
      const h = this._probeHits[k];
      if (h <= 0) continue;
      strongest = Math.max(strongest, h);
      // Slide along the wall rather than bouncing off it.
      const n = this._probeNormals[k];
      _v3.set(-n.z, 0, n.x);
      if (_v3.dot(forward) < 0) _v3.multiplyScalar(-1);
      this.avoidance.addScaledVector(n, h * PROBES[k].weight * 0.7);
      this.avoidance.addScaledVector(_v3, h * PROBES[k].weight * 0.6);
      // Decay so a stale hit does not steer forever.
      this._probeHits[k] = Math.max(0, h - dt * 2.2);
    }
    this.blocked = strongest > 0.72;
    if (this.avoidance.lengthSq() > 1) this.avoidance.normalize();
  }

  _trackStuck(dt, position, desiredSpeed) {
    this._window += dt;
    _v1.subVectors(position, this._last);
    _v1.y = 0;
    this._accum += _v1.length();
    this._last.copy(position);
    this._intended += desiredSpeed * dt;
    if (this._window < 1.1) return;
    const wanted = this._intended;
    this.isStuck = wanted > 0.5 && this._accum < wanted * 0.28;
    if (this.isStuck) {
      this.stuckCount++;
      this._detourTimer = 0.9 + this._rnd() * 0.8;
      this._detourSign = this._rnd() < 0.5 ? -1 : 1;
    } else {
      this.stuckCount = 0;
    }
    this._window = 0;
    this._accum = 0;
    this._intended = 0;
  }

  /** Called by the NPC when it accepts a re-target so the flag does not latch. */
  acknowledgeStuck() {
    this.isStuck = false;
  }
}
