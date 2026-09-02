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
 * ── What that argument does and does not rule out ──────────────────────────
 * It rules out *drawing* an elbow. It does not rule out *solving* for one. The
 * two-bone solve was rejected above because everything it computes past the
 * elbow is thrown away - and that is still true, so the far bone here is thrown
 * away, clipped to nothing by the same near-plane guard as before. What is not
 * thrown away is the elbow's position, because that is what the *forearm* aims
 * at, and the forearm is the half in shot. An arm aimed straight at the
 * shoulder can only ever get longer and shorter as the hand moves; an arm aimed
 * at a solved elbow flexes when the hand comes in and straightens when it
 * extends, which is the difference between a pole and a limb.
 *
 * Measured, so the length claim above is not folklore: at the sword's wrist
 * depths (0.40 - 0.52 m in front of the eye) the guard pins the drawn shaft to
 * exactly 0.2600 m every frame - `minLength` falls straight out of the algebra
 * - and it varies only outside that band (0.217 m at 0.36, 0.286 m at 0.60).
 * So the shaft was never the wobbling, rate-varying taper it looked like in
 * source. It was a rigid pole of constant length pointed at a shoulder, which
 * is a different complaint and the one the elbow answers.
 *
 * The mesh lives under the weapon's `root`, so it inherits the FOV-compensation
 * scale the rest of the viewmodel gets, and the wrist is converted into that
 * same space before solving - never world space, which would smear the arm
 * across the screen every time the player turned.
 *
 * ── The three opt-in channels, and why they are opt-in ─────────────────────
 * `elbow`, `roll` and `damping` are all off unless a weapon asks for them, and
 * with all three off this class computes byte-for-byte what it computed before
 * they existed. That is deliberate: the rifle and the bow were tuned against
 * the straight, snapped, roll-free solve, and the bow in particular puts its
 * anchor *in front of* the eye as a deliberate elbow position (see the guard in
 * `solve`), where a two-bone solve would be actively wrong. Only the sword -
 * the one weapon whose hand travels far enough for any of this to be visible -
 * turns them on.
 */

const AXIS_Y = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Quaternion();
const _wrist = new THREE.Vector3();
const _dir = new THREE.Vector3();
/* two-bone solve */
const _bone = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _elbow = new THREE.Vector3();
const _up = new THREE.Vector3();
const _local = new THREE.Vector3();
/* roll channel */
const _mRot = new THREE.Matrix4();
const _qAim = new THREE.Quaternion();
const _qHand = new THREE.Quaternion();
const _qRel = new THREE.Quaternion();
const _qTwist = new THREE.Quaternion();
const _qShare = new THREE.Quaternion();

const clamp = THREE.MathUtils.clamp;

/**
 * The component of `q` that is a rotation about `axis`, as a unit quaternion.
 *
 * Standard swing-twist decomposition: the twist is the vector part of `q`
 * projected onto the axis, kept with the original scalar part and renormalised.
 * Degenerate when `q` is a half-turn *about a perpendicular axis* - the
 * projection and `w` are then both ~0 - which cannot happen here (the hand
 * never sits 180 degrees off its own forearm) but is guarded anyway, because a
 * NaN quaternion propagates silently into the whole viewmodel transform.
 */
function twistAbout(q, axis, out) {
  const d = q.x * axis.x + q.y * axis.y + q.z * axis.z;
  const x = axis.x * d, y = axis.y * d, z = axis.z * d, w = q.w;
  const n = Math.sqrt(x * x + y * y + z * z + w * w);
  if (n < 1e-6) return out.identity();
  return out.set(x / n, y / n, z / n, w / n);
}

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
   *   plugScale?: number,                // joint-ball radius, as a multiple of the wrist
   *   minEyeDistance?: number,           // preferred limit on how near the far end comes
   *   minLength?: number,                // shaft length to buy back at that limit's expense
   *   elbow?: {fore:number, upper:number, pole:THREE.Vector3} | null,
   *   roll?: {source:THREE.Object3D, share:number} | null,
   *   damping?: number,                  // 1/seconds; 0 snaps, as it always did
   *   name?: string,
   * }} opts
   */
  constructor({
    parent, wrist, anchor, sleeve, band = null, wristRadius = 0.036, taper = 1.5,
    plugScale = 0.98, minEyeDistance = 0.34, minLength = 0.26,
    elbow = null, roll = null, damping = 0, name = 'viewmodel:arm',
  }) {
    this.parent = parent;
    this.wrist = wrist;
    /** Shoulder in `parent` space. Public: weapons lean it during animations. */
    this.anchor = anchor.clone();
    this.minEyeDistance = minEyeDistance;
    this.minLength = minLength;
    /**
     * Two-bone solve. `fore` is the only bone anyone ever sees, so it is the
     * one held at a fixed length; `upper` is a *tuning* number for how bent the
     * arm reads, not an anatomical measurement, because the bone it names lives
     * behind the near plane in every pose these weapons can hold.
     */
    this.elbow = elbow ? {
      fore: elbow.fore,
      upper: elbow.upper,
      pole: elbow.pole.clone().normalize(),
    } : null;
    this.roll = roll && roll.source && roll.share > 0 ? roll : null;
    this.damping = damping;
    this.disposables = [];

    this.group = new THREE.Group();
    this.group.name = name;
    parent.add(this.group);

    /* ---- wrist end: fixed size, because this is the part on screen ---- */
    const cuffBucket = [];
    const bandBucket = [];

    // Plug filling the seam between the cuff and the back of the hand.
    //
    // `plugScale` exists because on the sword this ball is a 35 mm sphere
    // sitting in a hand-heel 20 mm deep, so it stands proud of the pocket it is
    // meant to fill. That is invisible while the fist and the arm share one
    // rotation and unmissable the moment they do not, which is exactly the
    // change the sword's wrist joint made.
    const plug = new THREE.SphereGeometry(wristRadius * plugScale, 12, 8);
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

    // Upper arm: a second, independently aimed bone hung off the far end of the
    // forearm. Same material and same material *family*, so it costs no shader
    // program - the station's boot-warm budget has half its margin left and a
    // new program family in a viewmodel would eat some of it.
    //
    // It is almost never drawn. The near-plane guard below measures from the
    // elbow, and with the elbow already sitting ~0.23 m from the eye the guard
    // usually leaves this bone zero length. That is the point: its job is to
    // *place* the elbow, and therefore to aim the forearm, not to be seen.
    if (this.elbow) {
      this.upperPivot = new THREE.Group();
      this.upperPivot.name = `${name}:elbow`;
      this.group.add(this.upperPivot);
      this.upper = new THREE.Group();
      this.upper.name = `${name}:upper`;
      this.upperPivot.add(this.upper);
      const r0 = wristRadius * taper;
      const up = new THREE.CylinderGeometry(r0, r0 * 1.22, 1, 14, 1, true);
      up.translate(0, 0.5, 0);
      const upGeo = prep(up);
      this.disposables.push(upGeo);
      this.upper.add(this._mesh(upGeo, sleeve, `${name}:upper-sleeve`));
    } else {
      this.upperPivot = null;
      this.upper = null;
    }

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
   * How long a bone starting at `from` and pointing along `dir` may be drawn.
   *
   * ── Stop short of the eye ───────────────────────────────────────────────
   * The shoulder is behind the camera, so a shaft drawn all the way to it
   * would cross the near plane - and viewmodel materials carry
   * `patchViewmodelDepth`, which rewrites clip-space z to sit within
   * 0.0005 of the near limit. Geometry that genuinely approaches the near
   * plane clamps to *exactly* -w there, lands on the clip boundary, and gets
   * dropped. The symptom is not subtle and cost an hour to pin down: with the
   * patched material the whole forearm vanished while the same geometry drew
   * fine with an unpatched one, which looks like a material bug and is not.
   *
   * `parent` is unrotated and untranslated relative to the camera (it only
   * carries the FOV scale, which is 1 on Z), so its z *is* view z and the
   * clamp is a single divide. The arm leaves the bottom of the frame long
   * before this limit, so nothing that was on screen is lost.
   * An anchor placed in *front* of the eye is a deliberate elbow position -
   * an archer's flared draw, say - and must be reached exactly, or the arm is
   * amputated in mid-frame with its open end showing. Only an anchor behind
   * the eye needs the guard at all.
   */
  _reach(from, dir, want) {
    let len = want;
    let floor = this.anchor.z < 0 ? Math.min(this.minEyeDistance, -this.anchor.z) : this.minEyeDistance;

    if (dir.z > 1e-4) {
      // A hand that is already close to the eye - a rifle's firing hand, a bow
      // at full draw - has very little room in front of the guard, and a flat
      // limit leaves it wearing a stump. Give ground toward the eye to buy a
      // forearm's worth of length, but never past `HARD_NEAR`, which is where
      // the depth patch starts eating geometry.
      const wanted = -from.z - this.minLength * dir.z;
      floor = Math.min(floor, Math.max(HARD_NEAR, wanted));
      const reach = (-floor - from.z) / dir.z;
      if (reach > 0) len = Math.min(len, reach);
    }
    return Math.max(len, 1e-3);
  }

  /**
   * Re-aim the arm. Call once per frame *after* the weapon has written its
   * pose - this reads the matrices that pose produced.
   *
   * ── The roll channel, and exactly what it is worth ────────────────────────
   * `setFromUnitVectors` picks the minimal rotation, which discards the hand's
   * twist about the forearm axis. The header of this class used to argue that
   * was harmless, and on *this* mesh it is still literally true: the shaft is a
   * cone and the cuff is a length of cylinder, both rotationally symmetric, so
   * no roll applied here changes a single pixel. Do not read the code below as
   * the fix for the fist screwing round on the end of the arm - that is fixed
   * where it is caused, by the sword giving its hand a real wrist joint and
   * counter-rotating it against the blade.
   *
   * What this does is make the forearm carry a share of the twist rather than
   * none of it, so the angle left at the joint is one a wrist can hold. It is
   * here rather than in the weapon so that the day this shaft grows a seam, a
   * strap or a sleeve fold, it is already right. Two limits, stated so nobody
   * later believes more of it than is true: it is measured against the *aimed*
   * frame, so it carries the constant offset between the hand's own axes and
   * the arm's +Y, which is inert on symmetric geometry and would need zeroing
   * against a rest pose on geometry that is not; and it is a share, not a
   * solve, because a real forearm's pronation is coupled to the humerus and
   * nothing here models a humerus.
   *
   * @param {number} dt frame seconds; 0 (the default, and what every caller but
   *   the sword passes) snaps to the solution exactly as this always did.
   */
  solve(dt = 0) {
    this.wrist.updateWorldMatrix(true, false);
    _wrist.setFromMatrixPosition(this.wrist.matrixWorld);
    this.parent.worldToLocal(_wrist);
    this.group.position.copy(_wrist);

    _dir.subVectors(this.anchor, _wrist);
    const span = _dir.length();
    if (span < 1e-4) return;
    _dir.multiplyScalar(1 / span);

    // ── Where the first bone points ─────────────────────────────────────────
    // With no elbow it points at the anchor and stretches to reach, which is
    // what every weapon but the sword still wants. With one, the cosine rule
    // places the elbow off that line and the forearm aims there instead, at a
    // FIXED length - so the visible bone keeps its taper exactly and the far
    // bone, which nobody can see, absorbs all the stretch.
    _bone.copy(_dir);
    let want = span;
    if (this.elbow) {
      const a = this.elbow.fore;
      const b = this.elbow.upper;
      const cos = clamp((a * a + span * span - b * b) / (2 * a * span), -1, 1);
      const th = Math.acos(cos);
      // Pole vector: where the elbow goes when the arm flexes. Orthogonalised
      // against the aim so the bend is always square to it; a pole parallel to
      // the aim (the hand held straight out along the shoulder line) leaves no
      // plane to bend in, and the fallback keeps the elbow below rather than
      // letting a zero-length vector normalise to NaN.
      _pole.copy(this.elbow.pole).addScaledVector(_dir, -this.elbow.pole.dot(_dir));
      if (_pole.lengthSq() < 1e-8) _pole.set(0, -1, 0).addScaledVector(_dir, _dir.y);
      _pole.normalize();
      _bone.copy(_dir).multiplyScalar(cos).addScaledVector(_pole, Math.sin(th));
      want = a;
    }

    const foreLen = this._reach(_wrist, _bone, want);
    _qAim.setFromUnitVectors(AXIS_Y, _bone);

    if (this.roll) {
      // Hand twist, in `parent` space. Both matrices are current: the wrist's
      // `updateWorldMatrix(true, ...)` above refreshed the whole ancestor chain,
      // and the hand hangs off that same chain.
      this.roll.source.updateWorldMatrix(true, false);
      _qHand.setFromRotationMatrix(_mRot.extractRotation(this.roll.source.matrixWorld));
      _qRel.setFromRotationMatrix(_mRot.extractRotation(this.parent.matrixWorld)).invert();
      _qHand.premultiply(_qRel);
      // The rotation that takes the aimed frame to the hand's, then only the
      // part of it that spins about the forearm.
      _qRel.copy(_qAim).invert().premultiply(_qHand);
      twistAbout(_qRel, _bone, _qTwist);
      // Take a share of it. `slerp` from identity, not a scale on the angle:
      // the target has to be read before the accumulator is overwritten, which
      // is why this needs its own scratch rather than reusing `_qTwist`.
      _qShare.copy(IDENTITY).slerp(_qTwist, this.roll.share);
      _qAim.premultiply(_qShare);
    }

    // Inertia. Everything else in a viewmodel is on a spring; an arm that
    // snapped to its solution was the one rigid thing in the frame. Only the
    // rotation is damped - the position has to track the hand exactly or the
    // arm visibly detaches from it - so for a frame or two the shaft points
    // slightly off the anchor. That is unobservable for the same reason the
    // stretch is: the end it misses by is behind the near plane.
    if (dt > 0 && this.damping > 0) {
      this.group.quaternion.slerp(_qAim, 1 - Math.exp(-dt * this.damping));
    } else {
      this.group.quaternion.copy(_qAim);
    }

    // Only Y. Scaling all three would thin the forearm as it lengthened, and
    // the wrist end - the end anyone can see - has to keep its size.
    this.shaft.scale.y = Math.max(foreLen, 1e-3);

    if (this.upperPivot) {
      this.upperPivot.position.y = foreLen;
      _elbow.copy(_wrist).addScaledVector(_bone, foreLen);
      _up.subVectors(this.anchor, _elbow);
      const rest = _up.length();
      if (rest < 1e-4) {
        this.upper.scale.y = 1e-3;
      } else {
        _up.multiplyScalar(1 / rest);
        // Aim in the group's own (damped) frame, so the two bones stay joined
        // even on the frames the damping has the forearm lagging.
        _local.copy(_up).applyQuaternion(_qRel.copy(this.group.quaternion).invert());
        this.upperPivot.quaternion.setFromUnitVectors(AXIS_Y, _local);
        this.upper.scale.y = Math.max(this._reach(_elbow, _up, rest), 1e-3);
      }
    }
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
