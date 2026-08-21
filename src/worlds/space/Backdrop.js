import * as THREE from 'three';
import { proxyPlacement, proxyDistance, NEAR_FIELD, FAR_SAFE } from './Scale.js';

/**
 * THE BACKDROP DRIVER - one place that moves everything distant, once a frame.
 *
 * ===========================================================================
 *  WHAT IT DOES
 * ===========================================================================
 *
 * Members register a THREE.Object3D, a TRUE-frame position and a TRUE radius.
 * Every frame this reads the camera, asks `Scale.proxyPlacement` where each
 * member should be drawn, writes the position and the uniform scale, and
 * assigns render orders so the whole set paints back to front.
 *
 * Nothing else in the space world is allowed to move a distant object. Two
 * places that both position a planet is how a planet ends up half a degree
 * away from its own nav marker.
 *
 * ===========================================================================
 *  PAINTER ORDERING, AND WHY THE DEPTH BUFFER IS NOT USED
 * ===========================================================================
 *
 * The obvious design is to trust the depth buffer: the proxy map is monotone,
 * so nearer bodies get smaller proxy distances and the test sorts them. That
 * is wrong, and it is wrong in the default layout rather than in some contrived
 * one. Measured, with the shipped bodies, from the dock:
 *
 *     Cinder     true  62 km  ->  proxy 1659.2   (cap bound: 1900/(1+0.145))
 *     Ceraunus   true 245 km  ->  proxy 1644.9   (cap bound: 1900/(1+0.155))
 *
 * Cinder is four times nearer and lands FURTHER out. The far-limb cap in
 * Scale.js is the cause: it pulls a body in by its angular size, and Ceraunus
 * is angularly larger than Cinder despite being further away. Any body big
 * enough to be worth drawing is big enough to break the ordering.
 *
 * So the depth test is switched off for backdrop BODIES and draw order decides.
 * That is not a compromise; for this content it is exact. The bodies are
 * convex, opaque, and separated by tens of kilometres - they cannot interpenet-
 * rate and they cannot mutually overlap in a cycle, which are the only two
 * cases painter's algorithm gets wrong.
 *
 * ---- Two classes of member ------------------------------------------------
 *
 * `addBody`      A sphere with real angular size. depthTest OFF, depthWrite
 *                OFF. Ordered by draw order alone.
 *
 * `addStructure` A cluster of small things - the asteroid field, the dock -
 *                that needs its own internal depth sorting. depthTest ON,
 *                depthWrite ON. Safe because the cap NEVER BINDS for a member
 *                whose parts are angularly small, so the map is strictly
 *                monotone for them and the buffer tells the truth. `_audit`
 *                below checks that claim every frame in dev and complains once
 *                if it ever stops holding.
 *
 * Both classes share one sorted list, so a structure correctly paints over a
 * body behind it and under a body in front of it.
 *
 * ---- renderOrder DOES NOT INHERIT -----------------------------------------
 *
 * The obvious implementation - write `renderOrder` on the member's Group and
 * let its children follow - does nothing at all. three sorts the flat list of
 * renderable objects by each object's OWN `renderOrder`; a Group is not
 * renderable and its value is never consulted by its children.
 *
 * The failure is quiet and it does not look like a sorting bug. Every mesh
 * keeps renderOrder 0, three falls back to its own front-to-back ordering, and
 * because the bodies have the depth test switched off the LAST one drawn simply
 * wins. What you see is a planet painted flatly over the dock's piers, which
 * reads as a transparency mistake rather than as an ordering one. That is how
 * this shipped for one screenshot.
 *
 * So every member records its LEAF meshes at registration and the render order
 * is written onto each of them. Members get a band of `SLOTS` values rather
 * than one, so a body can order its own parts inside its slot: surface, then
 * ring, then atmosphere, then corona. Tag a mesh with
 * `userData.backdropSub = n` to place it in the band.
 *
 * ---- The consequence for everyone else ------------------------------------
 *
 * The backdrop occupies render orders in [BACKDROP_FIRST, 0). NOTHING in the
 * near field may take a negative render order or it will be painted over by a
 * planet.
 */

/** Render orders are assigned from here upwards, staying below 0. */
const BACKDROP_FIRST = -900;

/**
 * Render-order values reserved per member, so a member can sort its own parts.
 * 8 members * 8 slots = 64 values, all comfortably inside [-900, 0).
 */
const SLOTS = 8;

/** Module-level scratch. Nothing in this file allocates per frame. */
const _camPos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _place = { d: 0, scale: 0 };

/**
 * Cheap pre-filter for the audit below: below this angular radius the
 * far-limb cap provably cannot bind, so there is nothing to check. 0.14 rad is
 * 8 degrees. Above it the audit does the real test rather than assuming the
 * worst - the dock crosses 8 degrees at 3 km and is still perfectly safe.
 */
const STRUCTURE_Q_LIMIT = 0.14;

export class Backdrop {
  /**
   * @param {THREE.Camera|null} camera the live camera, read every frame. Null
   *        in a head-less build, in which case `update` is a no-op.
   */
  constructor(camera) {
    this.camera = camera;

    /** @type {Array<{object:THREE.Object3D, pos:THREE.Vector3, radius:number,
     *                 isBody:boolean, onPlace:Function|null, D:number, d:number,
     *                 scale:number, name:string}>} */
    this.members = [];

    /** Preallocated index array for the sort. Grown on registration only. */
    this._order = [];

    /** Set once if a structure ever violates STRUCTURE_Q_LIMIT. */
    this._audited = false;

    /** Cost of the last `update`, milliseconds. Read by the harness. */
    this.lastCostMs = 0;
  }

  /**
   * @param {THREE.Object3D} object the node to place. Its scale is OVERWRITTEN
   *        each frame, so anything needing a fixed non-unit scale must be a
   *        child with that scale on it.
   * @param {number[]} truePosition [x,y,z] in the true frame
   * @param {number} trueRadius metres; the sphere that contains the member
   * @param {{ isBody?: boolean, name?: string, transform?: boolean,
   *           onPlace?: (obj:THREE.Object3D, d:number, scale:number, D:number) => void }} opts
   *        `onPlace` runs after the transform is written, for members with
   *        uniforms that depend on the proxy frame - the ring is one.
   *
   *        `transform: false` means "rank me but do not move me". A member
   *        made of parts spread over kilometres, where the parts near the
   *        camera must stay at their TRUE positions because the player can
   *        collide with them, has to place its own parts individually. The
   *        asteroid field is the case; see the note in Belt.js on why a single
   *        group scale is angularly exact and still wrong.
   */
  add(object, truePosition, trueRadius, opts = {}) {
    if (!Number.isFinite(trueRadius) || trueRadius < 0) {
      throw new Error(`[space/Backdrop] member "${opts.name}" has radius ${trueRadius}`);
    }
    for (const c of truePosition) {
      if (!Number.isFinite(c)) {
        throw new Error(`[space/Backdrop] member "${opts.name}" has a non-finite position`);
      }
    }
    const m = {
      object,
      pos: new THREE.Vector3(truePosition[0], truePosition[1], truePosition[2]),
      radius: trueRadius,
      isBody: opts.isBody !== false,
      transform: opts.transform !== false,
      onPlace: opts.onPlace ?? null,
      name: opts.name ?? object.name ?? 'unnamed',
      D: 0,
      d: 0,
      scale: 1,
    };
    /* Leaf meshes, captured once. See the renderOrder note in the header:
     * writing the order on `object` alone is a no-op. Captured at registration
     * rather than per frame because a traverse of the dock's hundred boxes
     * every frame would be a real cost for a set that never changes. */
    m.parts = [];
    object.traverse((o) => {
      if (o.isMesh || o.isPoints || o.isLine || o.isSprite) {
        m.parts.push({ mesh: o, sub: Math.min(o.userData.backdropSub ?? 0, SLOTS - 1) });
      }
    });
    if (m.parts.length === 0) {
      throw new Error(`[space/Backdrop] member "${m.name}" has no drawable meshes to order`);
    }

    this.members.push(m);
    this._order.push(this.members.length - 1);
    return m;
  }

  /** A sphere with real angular size. See the header. */
  addBody(object, truePosition, trueRadius, opts = {}) {
    return this.add(object, truePosition, trueRadius, { ...opts, isBody: true });
  }

  /** A cluster that sorts itself on the depth buffer. See the header. */
  addStructure(object, truePosition, trueRadius, opts = {}) {
    return this.add(object, truePosition, trueRadius, { ...opts, isBody: false });
  }

  /**
   * Place everything for this frame.
   *
   * Call it AFTER the camera has been given its final position for the frame
   * and BEFORE the render. In the frame loop that means inside the active
   * world's `update`, which main.js runs after `cameraRig.update`.
   */
  update() {
    const members = this.members;
    const n = members.length;
    if (n === 0) return;

    /* NO CAMERA, NOTHING TO PLACE.
     *
     * A world is built head-less by most of the suite - `WorldManager.build`
     * runs against a stub context with no renderer and no camera - and this is
     * called once at the end of `SpaceWorld.build` to prime the first frame.
     * Without this guard that priming call takes down every test that builds
     * the space world, including six in dock-launch.test.mjs that are about
     * the DOCK and only touch this world in passing. It did exactly that.
     *
     * Skipping is correct rather than merely safe: a context with no camera
     * renders no frames, so there is no frame to get wrong. */
    if (!this.camera) return;

    const t0 = performance.now();
    this.camera.getWorldPosition(_camPos);

    for (let i = 0; i < n; i++) {
      const m = members[i];
      _dir.copy(m.pos).sub(_camPos);
      const D = _dir.length();
      m.D = D;

      /* NAME THE MEMBER, DO NOT LET `proxyDistance` THROW A RIDDLE.
       *
       * `NaN < 1e-3` is FALSE, so a non-finite distance sails straight past the
       * zero guard below and dies two frames later inside `Scale.proxyDistance`
       * as "needs a finite positive distance, got NaN" - with no member, no
       * world and no position in the message. That cost a real debugging
       * session: the error names the arithmetic that noticed, not the data that
       * was wrong, and the data is a hundred metres up the call stack.
       *
       * Checked here, where the member is still in hand. `_camPos` is included
       * because the other half of this subtraction is the camera, and a camera
       * with a NaN in its matrix produces exactly the same symptom from a
       * completely different cause. */
      if (!Number.isFinite(D)) {
        throw new Error(
          `[space/Backdrop] member "${m.name}" is ${D} metres from the camera: `
          + `pos (${m.pos.x}, ${m.pos.y}, ${m.pos.z}), `
          + `camera (${_camPos.x}, ${_camPos.y}, ${_camPos.z}), `
          + `radius ${m.radius}`
        );
      }

      /* The camera sitting exactly on a member's centre is not a hypothetical:
       * it is the frame the dock exterior is placed on when the player spawns
       * inside it. Leave it where it is rather than dividing by zero. */
      if (D < 1e-3) {
        m.d = 0;
        m.scale = 1;
        if (m.transform) {
          m.object.position.copy(m.pos);
          m.object.scale.setScalar(1);
        }
        continue;
      }

      _dir.multiplyScalar(1 / D);
      proxyPlacement(D, m.radius, _place);
      m.d = _place.d;
      m.scale = _place.scale;

      /* Scaling a rigid group about the CAMERA - which is what setting the
       * group origin to `camPos + dir*d` and the scale to `d/D` does - moves
       * every child to `camPos + s*(childTrueOffsetFromCamera)`. A uniform
       * scale about the eye changes no direction and no ratio of directions,
       * so EVERY part of the group keeps its exact angular position and its
       * exact angular size, not just the centre. That is what makes a 400 m
       * dock and an 11 km debris field placeable as single members. */
      if (m.transform) {
        m.object.position.copy(_camPos).addScaledVector(_dir, _place.d);
        m.object.scale.setScalar(_place.scale);
      }
      if (m.onPlace) m.onPlace(m.object, _place.d, _place.scale, D);
    }

    this._sort();

    const order = this._order;
    for (let rank = 0; rank < n; rank++) {
      // Furthest first. renderOrder rises as things get nearer.
      const base = BACKDROP_FIRST + rank * SLOTS;
      const parts = members[order[rank]].parts;
      for (let p = 0; p < parts.length; p++) parts[p].mesh.renderOrder = base + parts[p].sub;
    }

    if (!this._audited) this._audit();
    this.lastCostMs = performance.now() - t0;
  }

  /**
   * Insertion sort on the index array, furthest true distance first.
   *
   * Insertion and not `Array.prototype.sort`: the comparator would allocate a
   * closure every frame, and the array is seven long and almost always already
   * in order, which is the case insertion sort is O(n) on. The speed is not
   * the point and is not claimed - the whole backdrop plus 260 belt rocks
   * measures 0.03 ms together, so neither sort is visible in it. The point is
   * the house rule: nothing allocates inside a frame handler.
   */
  _sort() {
    const order = this._order;
    const members = this.members;
    for (let i = 1; i < order.length; i++) {
      const v = order[i];
      const key = members[v].D;
      let j = i - 1;
      while (j >= 0 && members[order[j]].D < key) {
        order[j + 1] = order[j];
        j--;
      }
      order[j + 1] = v;
    }
  }

  /**
   * Check the one invariant the depth-writing members depend on, and say so
   * loudly the first time it breaks.
   *
   * A structure is safe only while its angular radius keeps the far-limb cap
   * out of play. Fly close enough to the asteroid field and its bounding
   * sphere subtends more than STRUCTURE_Q_LIMIT - at which point its proxy
   * distance is capped, and it can be drawn nearer than something it is
   * actually behind. That is a real bug, it is silent, and it looks like "the
   * planet is in front of the rocks for a second", which nobody reports.
   *
   * Once per session, not once per frame: a warning in a frame handler is a
   * frame handler that allocates a string 60 times a second.
   */
  _audit() {
    for (let i = 0; i < this.members.length; i++) {
      const m = this.members[i];
      if (m.isBody || m.D <= 0) continue;
      /* A member that places its own parts never uses the group's capped
       * distance for anything - only its RANK, which comes from the true
       * distance and is unaffected by the cap. The asteroid field trips the
       * angular test the moment you get near it and is entirely safe; auditing
       * it was a false positive that fired on the first frame in the browser. */
      if (!m.transform) continue;
      const q = m.radius / m.D;
      if (q <= STRUCTURE_Q_LIMIT) continue;
      // Only actually a problem if the cap is what chose the distance.
      if (proxyDistance(m.D) <= FAR_SAFE / (1 + q)) continue;
      this._audited = true;
      console.warn(
        `[space/Backdrop] structure "${m.name}" is angularly large (q=${q.toFixed(3)}) and ` +
          `its proxy distance is cap-bound, so its depth is no longer ordered against the ` +
          `bodies. Split it into smaller members or give it a body's render state. ` +
          `Reported once.`
      );
      return;
    }
  }

  /** Debug readout: what got drawn where, furthest first. Harness-facing. */
  report() {
    return this._order.map((i) => {
      const m = this.members[i];
      return {
        name: m.name,
        kind: m.isBody ? 'body' : 'structure',
        renderOrderBase: BACKDROP_FIRST + this._order.indexOf(i) * SLOTS,
        trueKm: +(m.D / 1000).toFixed(2),
        proxy: +m.d.toFixed(1),
        scale: +m.scale.toExponential(3),
        drawnRadius: +(m.radius * m.scale).toFixed(1),
        renderOrder: m.object.renderOrder,
        identity: m.D <= NEAR_FIELD,
      };
    });
  }
}
