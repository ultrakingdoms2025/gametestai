import * as THREE from 'three';

const _sample = { x: 0, y: 0, z: 0, width: 12, tx: 0, tz: -1 };
const _normal = new THREE.Vector3(0, 0, 1);
const _dir = new THREE.Vector3();
const _quat = new THREE.Quaternion();

/**
 * The dragon race, as one record.
 *
 * `flightHeight` is the whole route: the rings are hung at it, the player is
 * placed on it and every rival flies it. That is deliberate and it is the fix
 * for the defect below - the number used to be written here AND again in
 * RacerAI, and two copies of a route are two routes.
 *
 * ── Why 15 and not 10 ──────────────────────────────────────────────────────
 *
 * Because the start/finish gantry is solid, and at 10 m the route went through
 * it. The crossbeam collider (RaceWorld._buildPaddock: centre `g.y + 11.05`,
 * half-extents `wHalf + 1.2` x 1.4 x 1.2) spans the whole road plus its
 * run-off, 2.4 m deep along the track, from road+9.65 m to road+12.45 m. A
 * dragon's body is a capsule of radius 1.5 and height 3.2 centred on
 * `position`, so at a flight height of 10 the route sat 1.95 m INSIDE the beam,
 * once per lap, at the one point every lap has to cross.
 *
 * What that felt like was not a bump. `Dragon._resolveCollision` scrubs 20% of
 * the speed per step against a horizontal pushout, and `damp(v, 30, 3.3, 1/60)`
 * followed by `speed *= 0.8` has a stable fixed point at 5.289512 m/s -
 * reproduced here from six different starting speeds and matching the closed
 * form `0.8*30*(1-k)/(1-0.8k)`, k = exp(-3.3/60). So the mount arrived at the
 * beam, jammed, and sat at a sixth of its boost speed.
 *
 * ── What that costs, measured in the running game ──────────────────────────
 *
 * Not deduced from the paragraph above: measured in the browser build with
 * `flightHeight` put back to 10, CONTENDER, all three circuits, stepped by the
 * game's own fixed updaters. What it costs depends entirely on whether the
 * pilot gives the altitude up, so both are quoted.
 *
 * A pilot that HOLDS the flight line - servoing back to `centreline + 10`, the
 * altitude the rings are hung at - is pinned at 5.29 m/s and completes NO lap
 * at all: zero laps in 300 s of race clock on all three circuits, stuck between
 * the grid and the line from about t = 3 s. It never reaches the line to begin
 * the first lap.
 *
 * A pilot that climbs out of the beam instead gets round, and pays between 0.86
 * and 0.89 s a lap for it. Same autopilot at both heights, four laps each,
 * steady-lap times in seconds:
 *
 *              flight 15    flight 10    per lap
 *   Vellum       53.800       54.667      +0.867
 *   Cinder       44.850       45.733      +0.883
 *   Aurora       43.300       44.167      +0.867
 *
 * Vellum's and Aurora's laps repeat to the millisecond; Cinder's wander by a
 * fixed step or two either way. Every lap contains exactly one gantry event, and
 * every one of them reads the same: scrubbed below 20 m/s, bottoming at 5.29,
 * back to 28 m/s 1.383 s later. At flight height 15 that event does not occur
 * on any lap of any circuit.
 *
 * The stall DISTANCES an earlier draft of this note quoted - 1595.6 m of 1598.3
 * on Vellum, 1291.7 of 1294.5 on Cinder, 1216.2 of 1218.9 on Aurora - are a
 * property of one harness and not of the game. They reproduce exactly, but only
 * in a fixed-dt level-flight lap begun ON the line at s = 0, which is the only
 * way the mount gets to the far side of the circuit before it meets the beam.
 * Started where the game starts it, on the grid 56 m back, it never reaches the
 * line at all.
 *
 * The clear band is measured, not guessed. Sweeping the real colliders every
 * 0.25 m round all three laps, across the corridor `_clampPlayerDragon`
 * actually allows, every height from 8.5 to 14 is obstructed and 14.1 is the
 * first that measures clean, so 15 carries about 0.9 m of margin. (4.5 to 8 is
 * clear too - under the beam, 0 obstructed samples of 82 305 at every height
 * tried in that band - and 4 starts catching road furniture at 110 samples.)
 * scripts/tests/race-dragon-line.test.mjs is that sweep, so the next thing that
 * grows into the flight corridor fails the suite instead of the race.
 *
 * Do NOT compromise between the two. 11 m is measurably WORSE than the 10 m it
 * would be replacing, on the same sweep and by the same metric - MAXIMUM
 * HORIZONTAL PUSHOUT over all three circuits: 2.700 m at 11 against 1.833 m at
 * 10. At 11 m the body sits far enough inside the beam that the vertical escape
 * measures exactly 0.000 m, so there is nowhere to be pushed but sideways,
 * where the speed penalty lives. (At 10 m the largest vertical pushout is
 * 1.957 m, and 1.707 m - which an earlier draft quoted as though it were the
 * same quantity - is Vellum's horizontal maximum alone. The 1.833 is Cinder's,
 * the largest of the three, and is the figure
 * scripts/tests/race-dragon-line.test.mjs states.) 12 m is no better: 332
 * obstructed samples, 1.951 m horizontal and 2.056 m vertical.
 */
export const DRAGON_RACE = {
  type: 'dragon',
  ringSpacing: 55,
  minRings: 10,
  maxRings: 18,
  flightHeight: 15,
  minFlight: 3,
  maxFlight: 25,
  ringRadius: 5.2,
};

function makeNumberTexture(n) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = 'rgba(3,8,16,0.72)';
  ctx.beginPath();
  ctx.roundRect(12, 22, 104, 84, 18);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,228,132,0.95)';
  ctx.lineWidth = 6;
  ctx.stroke();
  ctx.font = '800 58px "Chakra Petch", Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff4b8';
  ctx.shadowColor = 'rgba(255,180,74,0.9)';
  ctx.shadowBlur = 12;
  ctx.fillText(String(n), 64, 66);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildDragonRingCheckpoints(path) {
  if (!path?.valid) return [];
  const count = THREE.MathUtils.clamp(Math.round(path.length / DRAGON_RACE.ringSpacing), DRAGON_RACE.minRings, DRAGON_RACE.maxRings);
  const rings = [];
  for (let i = 0; i < count; i++) {
    path.sample(((i + 0.5) / count) * path.length, _sample);
    rings.push({
      x: _sample.x,
      y: _sample.y + DRAGON_RACE.flightHeight,
      z: _sample.z,
      radius: DRAGON_RACE.ringRadius,
      ring: true,
      index: i,
      number: i + 1,
      tx: _sample.tx,
      tz: _sample.tz,
      width: _sample.width,
    });
  }
  return rings;
}

/**
 * Everything about a ring that is a property of the CONTEST rather than of the
 * dragon race, with the dragon race's own values as the defaults.
 *
 * -- Why this is a parameter block and not a constant --------------------------
 *
 * `RaceRings` is the only in-world waypoint marker this project has, and it
 * looked generic while being nothing of the kind: the torus radius WAS
 * `DRAGON_RACE.ringRadius` = 5.2 m, the root was named `dragon-race-rings`,
 * the groups `dragon-ring-N`, and the number sprite hung off the same 5.2. A
 * 5.2 m unlit torus is not a rooftop checkpoint - a souk roof measures 8.5 m
 * across its lip on the outer ring, so the marker would stand wider than the
 * building it marks and the player would pass BESIDE it rather than through
 * it.
 *
 * Every default below is the dragon race's shipped value to the digit, so
 * `new RaceRings({ scene })` builds exactly what it built before.
 *
 * @typedef {object} RingStyle
 * @property {number} [radius] torus radius, metres
 * @property {number} [tube] torus tube radius, metres
 * @property {number} [labelGap] metres between the ring's top and the number
 * @property {number} [labelScale] number sprite size, metres
 * @property {number} [color] an unpassed ring
 * @property {number} [nextColor] the ring the cursor is on
 * @property {string} [name] the root object's name
 * @property {string} [groupPrefix] each ring group is named `${groupPrefix}-${n}`
 */

export class RaceRings {
  /**
   * @param {{scene?:THREE.Object3D} & RingStyle} opts
   */
  constructor({
    scene,
    radius = DRAGON_RACE.ringRadius,
    tube = 0.18,
    labelGap = 1.25,
    labelScale = 3.6,
    color = 0xffd166,
    nextColor = 0x52e9ff,
    name = 'dragon-race-rings',
    groupPrefix = 'dragon-ring',
  } = {}) {
    this.scene = scene;
    /** Torus radius in metres. Read by callers that size a pass test off it. */
    this.radius = radius;
    this.labelGap = labelGap;
    this.labelScale = labelScale;
    this.groupPrefix = groupPrefix;
    this.root = new THREE.Group();
    this.root.name = name;
    this.scene?.add?.(this.root);
    this.rings = [];
    this._torusGeo = new THREE.TorusGeometry(radius, tube, 10, 48);
    this._mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, toneMapped: false });
    this._nextMat = new THREE.MeshBasicMaterial({ color: nextColor, transparent: true, opacity: 1, toneMapped: false });
    this._passed = new Set();
  }

  setCheckpoints(cps) {
    this.clearMeshes();
    if (!Array.isArray(cps) || !cps.length) {
      this.root.visible = false;
      return;
    }
    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i];
      const group = new THREE.Group();
      group.name = `${this.groupPrefix}-${i + 1}`;
      group.position.set(cp.x, cp.y, cp.z);
      _dir.set(cp.tx ?? 0, 0, cp.tz ?? -1).normalize();
      if (_dir.lengthSq() < 0.5) _dir.set(0, 0, -1);
      _quat.setFromUnitVectors(_normal, _dir);
      group.quaternion.copy(_quat);

      const torus = new THREE.Mesh(this._torusGeo, i === 0 ? this._nextMat : this._mat);
      torus.renderOrder = 7;
      group.add(torus);

      const tex = makeNumberTexture(cp.number ?? i + 1);
      const labelMat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false });
      const label = new THREE.Sprite(labelMat);
      label.position.set(0, this.radius + this.labelGap, 0.1);
      label.scale.set(this.labelScale, this.labelScale, 1);
      group.add(label);

      this.root.add(group);
      this.rings.push({ group, torus, label, texture: tex, labelMat, baseY: cp.y });
    }
    this._passed.clear();
    this.root.visible = true;
    this.setNext(0);
  }

  clearMeshes() {
    for (const r of this.rings) {
      r.group.removeFromParent();
      r.texture?.dispose?.();
      r.labelMat?.dispose?.();
    }
    this.rings.length = 0;
    this._passed.clear();
  }

  clear() {
    this.clearMeshes();
    this.root.visible = false;
  }

  resetLap() {
    this._passed.clear();
    for (const r of this.rings) r.group.visible = true;
    this.setNext(0);
  }

  pass(index, nextIndex) {
    const r = this.rings[index];
    if (r) {
      r.group.visible = false;
      this._passed.add(index);
    }
    if (nextIndex === 0) this.resetLap();
    else this.setNext(nextIndex);
  }

  setNext(index) {
    for (let i = 0; i < this.rings.length; i++) {
      const r = this.rings[i];
      r.torus.material = i === index ? this._nextMat : this._mat;
      r.group.scale.setScalar(i === index ? 1.12 : 1);
    }
  }

  markers(nextIndex = 0) {
    const out = [];
    for (let i = 0; i < this.rings.length; i++) {
      if (this._passed.has(i)) continue;
      const g = this.rings[i].group;
      out.push({ type: 'ring', x: g.position.x, z: g.position.z, index: i, number: i + 1, next: i === nextIndex });
    }
    return out;
  }

  update(elapsed) {
    for (let i = 0; i < this.rings.length; i++) {
      const g = this.rings[i].group;
      g.position.y = this.rings[i].baseY + Math.sin(elapsed * 2.2 + i * 0.7) * 0.35;
    }
  }

  dispose() {
    this.clearMeshes();
    this._torusGeo.dispose();
    this._mat.dispose();
    this._nextMat.dispose();
    this.root.removeFromParent();
  }
}
