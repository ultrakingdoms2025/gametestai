import * as THREE from 'three';
import { prep, mergeBucket } from '../player/Weapon.js';

/**
 * A first-person forearm that is *solved* rather than modelled in place.
 *
 * ── Why not just bake the arm into the weapon, as every viewmodel here did ──
 * Every weapon in this project used to carry its own forearm as a cylinder
 * merged into the weapon's geometry. That works for exactly one pose. The
 * moment the weapon moves - a sword swing, a bow draw, an ADS pull-in, a
 * magazine change - the forearm rotates rigidly with it, which puts the elbow
 * wherever the weapon's rotation happens to throw it. In practice that meant
 * two failure modes, both of which were visible in-game:
 *
 *   * the elbow swings *up* into the middle of the frame and the arm reads as a
 *     log lying across the view (the bow at full draw did this with both arms);
 *   * the whole hand-and-arm assembly leaves the bottom of the screen and the
 *     weapon reads as floating with nothing holding it (the sword did this).
 *
 * A player's shoulder does not move when their wrist does. So this class fixes
 * the thing that is actually fixed - a shoulder anchor in view space - and
 * derives the forearm from it every frame: position at the wrist, aimed at the
 * anchor. The hand still rides the weapon rigidly, which is correct, and the
 * arm connecting it to the player is now always plausible for any pose the
 * weapon can reach, including ones nobody posed by hand.
 *
 * ── Why the arm stretches to the anchor instead of ending at a fixed length ─
 * A real two-bone solve would place the elbow on the circle of points `upper`
 * from the shoulder and `fore` from the wrist. We would then throw away
 * everything it computed, because the shoulder anchor sits *behind the eye* -
 * that is where a shoulder is - so the far half of the arm is behind the near
 * plane in every pose these weapons can hold.
 *
 * That geometry also rules out the obvious cheap version, a forearm of fixed
 * length aimed at the anchor. The hands here are 0.5-0.6 m in front of the eye
 * and the shoulder is 0.1 m behind it, so the arm runs very nearly *along* the
 * view axis; stopping it short parks its elbow cap a couple of hand-widths from
 * the camera, where a 5 cm ball fills a third of the screen. Tried it; it looks
 * exactly like the baked arms it replaced.
 *
 * So the shaft is a unit-length tube scaled to reach the anchor exactly. Its
 * far end is always behind the near plane and never drawn, which makes the one
 * artefact of stretching - a forearm that changes length - unobservable, while
 * the visible near end keeps a fixed wrist and a fixed taper. What the player
 * sees is a forearm receding past their own shoulder, which is what a
 * first-person arm is.
 *
 * The mesh lives under the weapon's `root`, so it inherits the FOV-compensation
 * scale the rest of the viewmodel gets, and the wrist is converted into that
 * same space before solving - never world space, which would smear the arm
 * across the screen every time the player turned.
 */

const AXIS_Y = new THREE.Vector3(0, 1, 0);
const _wrist = new THREE.Vector3();
const _dir = new THREE.Vector3();

/**
 * Closest the far end of a shaft may come to the eye, in metres.
 *
 * The camera's near plane is 0.1, and `patchViewmodelDepth` clamps clip-space z
 * to the near limit, so geometry that actually reaches the near plane lands on
 * the clip boundary and is dropped. 0.18 is comfortably clear of that and still
 * far enough forward that no arm has to be cut short inside the frame.
 */
const HARD_NEAR = 0.18;

export class ViewArm {
  /**
   * @param {{
   *   parent: THREE.Object3D,            // the weapon's `root` (camera space)
   *   wrist: THREE.Object3D,             // rides the hand; supplies the origin
   *   anchor: THREE.Vector3,             // shoulder, in `parent` space
   *   sleeve: THREE.Material,            // glove / leather
   *   band?: THREE.Material,             // cuff metal; omit to skip
   *   taper?: number,                    // far-end radius as a multiple of the wrist
   *   wristRadius?: number,
   *   minEyeDistance?: number,           // preferred limit on how near the far end comes
   *   minLength?: number,                // shaft length to buy back at that limit's expense
   *   name?: string,
   * }} opts
   */
  constructor({
    parent, wrist, anchor, sleeve, band = null, wristRadius = 0.036, taper = 1.5,
    minEyeDistance = 0.34, minLength = 0.26, name = 'viewmodel:arm',
  }) {
    this.parent = parent;
    this.wrist = wrist;
    /** Shoulder in `parent` space. Public: weapons lean it during animations. */
    this.anchor = anchor.clone();
    this.minEyeDistance = minEyeDistance;
    this.minLength = minLength;
    this.disposables = [];

    this.group = new THREE.Group();
    this.group.name = name;
    parent.add(this.group);

    /* ---- wrist end: fixed size, because this is the part on screen ---- */
    const cuffBucket = [];
    const bandBucket = [];

    // Plug filling the seam between the cuff and the back of the hand.
    const plug = new THREE.SphereGeometry(wristRadius * 0.98, 12, 8);
    plug.translate(0, wristRadius * 0.3, 0);
    cuffBucket.push(prep(plug));

    if (band) {
      // A short sleeve section, not a torus.
      //
      // A ring around the arm is the obvious way to draw a cuff and it is the
      // wrong one here: these arms point almost directly away from the eye, so
      // a torus is seen down its own axis in every frame and draws as a perfect
      // annulus - a tyre stuck to the wrist. A band of sleeve seen end-on is
      // just a slightly wider length of arm, which is what it should be.
      const cuff = new THREE.CylinderGeometry(
        wristRadius + 0.005, wristRadius + 0.003, wristRadius * 0.9, 14, 1, true
      );
      cuff.translate(0, wristRadius * 0.55, 0);
      bandBucket.push(prep(cuff));
    }

    /* ---- shaft: unit length along +Y, stretched to the anchor in `solve` ---- */
    this.shaft = new THREE.Group();
    this.shaft.name = `${name}:shaft`;
    this.group.add(this.shaft);

    // A cone, not a cylinder: a forearm that does not widen away from the wrist
    // reads as a length of pipe, which is what the baked arms looked like.
    const tube = new THREE.CylinderGeometry(wristRadius, wristRadius * taper, 1, 14, 1, true);
    tube.translate(0, 0.5, 0);
    const shaftGeo = prep(tube);
    this.disposables.push(shaftGeo);
    this.shaft.add(this._mesh(shaftGeo, sleeve, `${name}:sleeve`));

    for (const [bucket, mat, suffix] of [
      [cuffBucket, sleeve, 'wrist'],
      [bandBucket, band, 'band'],
    ]) {
      if (!mat || bucket.length === 0) continue;
      const geo = mergeBucket(bucket);
      if (!geo) continue;
      this.disposables.push(geo);
      this.group.add(this._mesh(geo, mat, `${name}:${suffix}`));
    }
  }

  /** Viewmodel mesh defaults, shared by every part of the arm. */
  _mesh(geometry, material, name) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;
    mesh.renderOrder = 100;
    return mesh;
  }

  /**
   * Re-aim the forearm. Call once per frame *after* the weapon has written its
   * pose - this reads the matrices that pose produced.
   *
   * The roll about the arm's own axis is left to `setFromUnitVectors`, which
   * picks the minimal rotation. Nothing on the forearm is roll-sensitive (see
   * the cuff and strap above), so there is no artefact to correct and no need
   * to carry the hand's twist across.
   */
  solve() {
    this.wrist.updateWorldMatrix(true, false);
    _wrist.setFromMatrixPosition(this.wrist.matrixWorld);
    this.parent.worldToLocal(_wrist);
    this.group.position.copy(_wrist);

    _dir.subVectors(this.anchor, _wrist);
    let len = _dir.length();
    if (len < 1e-4) return;
    _dir.multiplyScalar(1 / len);
    this.group.quaternion.setFromUnitVectors(AXIS_Y, _dir);

    // ── Stop short of the eye ───────────────────────────────────────────────
    // The shoulder is behind the camera, so a shaft drawn all the way to it
    // would cross the near plane - and viewmodel materials carry
    // `patchViewmodelDepth`, which rewrites clip-space z to sit within
    // 0.0005 of the near limit. Geometry that genuinely approaches the near
    // plane clamps to *exactly* -w there, lands on the clip boundary, and gets
    // dropped. The symptom is not subtle and cost an hour to pin down: with the
    // patched material the whole forearm vanished while the same geometry drew
    // fine with an unpatched one, which looks like a material bug and is not.
    //
    // `parent` is unrotated and untranslated relative to the camera (it only
    // carries the FOV scale, which is 1 on Z), so its z *is* view z and the
    // clamp is a single divide. The arm leaves the bottom of the frame long
    // before this limit, so nothing that was on screen is lost.
    // An anchor placed in *front* of the eye is a deliberate elbow position -
    // an archer's flared draw, say - and must be reached exactly, or the arm is
    // amputated in mid-frame with its open end showing. Only an anchor behind
    // the eye needs the guard at all.
    let floor = this.anchor.z < 0 ? Math.min(this.minEyeDistance, -this.anchor.z) : this.minEyeDistance;

    if (_dir.z > 1e-4) {
      // A hand that is already close to the eye - a rifle's firing hand, a bow
      // at full draw - has very little room in front of the guard, and a flat
      // limit leaves it wearing a stump. Give ground toward the eye to buy a
      // forearm's worth of length, but never past `HARD_NEAR`, which is where
      // the depth patch starts eating geometry.
      const wanted = -_wrist.z - this.minLength * _dir.z;
      floor = Math.min(floor, Math.max(HARD_NEAR, wanted));
      const reach = (-floor - _wrist.z) / _dir.z;
      if (reach > 0) len = Math.min(len, reach);
    }

    // Only Y. Scaling all three would thin the forearm as it lengthened, and
    // the wrist end - the end anyone can see - has to keep its size.
    this.shaft.scale.y = Math.max(len, 1e-3);
  }

  setVisible(on) {
    this.group.visible = on;
  }

  dispose() {
    this.group.removeFromParent();
    for (const d of this.disposables) d?.dispose?.();
    this.disposables.length = 0;
  }
}

export default ViewArm;
