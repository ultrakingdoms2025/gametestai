import * as THREE from 'three';

/**
 * A tennis racket, hand-merged the way `PlayerAvatar._buildWeapon` merges the
 * carbine: a handful of primitives baked into one frame geometry plus a second
 * translucent mesh for the string bed, because the strings want their own
 * lighter, unlit material and merging across materials buys nothing.
 *
 * Built in the weapon prop's local frame - the shaft runs along -Z, exactly
 * like the carbine's barrel - and pre-offset with the same grip transform
 * `PlayerAvatar` uses (`HAND_POS`/`HAND_ROT`, copied below with a pointer
 * back), so a caller just adds `racket.object` to a `humanoid.weaponMount`
 * and the grip lands in the palm. Deborah's humanoid comes from the same
 * factory with the same hand rest frame, so one prop shape serves both ends
 * of the court.
 *
 * Nothing here is shared or cached: a match builds at most two rackets and
 * holds them for minutes, so each instance owns its geometry and materials
 * outright and `dispose()` frees exactly what `createRacket` made.
 */

/* The grip transform, verbatim from PlayerAvatar.js (HAND_POS / HAND_ROT):
 * "aligns the prop's -Z with the aim direction", roll ~166 deg because the
 * hand bone's rest frame is close to inverted about the grip axis. Copied
 * rather than imported because those constants are private to the avatar. */
const GRIP_POS = [-0.015, -0.056, -0.046];
const GRIP_ROT = [-0.06, 0.03, 2.9];

/** Frame paint. A dark court blue, so the tennis-yellow ball never vanishes
 *  against the racket mid-swing. */
const FRAME_COLOUR = 0x37517e;
/** String bed: pale, translucent, unlit - reads as strings, costs one quad fan. */
const STRING_COLOUR = 0xd8e6ea;

/**
 * Merge indexed primitive geometries into one BufferGeometry - the same
 * routine `PlayerAvatar._buildWeapon` and `HostileNPC` use, kept local for
 * the same reason they keep it: six primitives is not worth an addon import.
 * @param {THREE.BufferGeometry[]} parts consumed (disposed) by the merge
 */
function mergeParts(parts) {
  let vTotal = 0;
  let iTotal = 0;
  for (const p of parts) {
    vTotal += p.getAttribute('position').count;
    iTotal += p.getIndex().count;
  }
  const pos = new Float32Array(vTotal * 3);
  const nrm = new Float32Array(vTotal * 3);
  const uv = new Float32Array(vTotal * 2);
  const idx = new Uint16Array(iTotal);
  let vo = 0;
  let io = 0;
  for (const p of parts) {
    const pp = p.getAttribute('position');
    pos.set(pp.array, vo * 3);
    nrm.set(p.getAttribute('normal').array, vo * 3);
    uv.set(p.getAttribute('uv').array, vo * 2);
    const pi = p.getIndex();
    for (let i = 0; i < pi.count; i++) idx[io + i] = pi.getX(i) + vo;
    vo += pp.count;
    io += pi.count;
    p.dispose();
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeBoundingSphere();
  return geo;
}

/**
 * Build one racket.
 *
 * ~0.65 m tip to butt: grip at the origin end, throat arms splaying out to an
 * elliptical head hoop (a torus squashed along X - long axis down the shaft,
 * face normal along Y, which is how a forehand carries it).
 *
 * @returns {{ object: THREE.Group, dispose: () => void }}
 */
export function createRacket() {
  const parts = [];
  const push = (geo, tf) => {
    tf?.(geo);
    parts.push(geo);
    return geo;
  };

  // Grip: butt at z +0.05, shaft toward -Z like the carbine's barrel.
  push(new THREE.CylinderGeometry(0.017, 0.019, 0.21, 8), (g) => {
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, -0.055);
  });
  // Collar where grip meets throat.
  push(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 8), (g) => {
    g.rotateX(Math.PI / 2);
    g.translate(0, 0, -0.175);
  });
  // Throat: two arms splayed toward the hoop's shoulders.
  for (const side of [1, -1]) {
    push(new THREE.BoxGeometry(0.018, 0.014, 0.14), (g) => {
      g.rotateY(-0.45 * side);
      g.translate(0.05 * side, 0, -0.24);
    });
  }
  // Head hoop: torus in the X-Z plane, squashed to an ellipse
  // (half-axes 0.12 across, 0.15 along the shaft), centred at z -0.45.
  push(new THREE.TorusGeometry(0.15, 0.014, 6, 24), (g) => {
    g.rotateX(Math.PI / 2);
    g.scale(0.8, 1, 1);
    g.translate(0, 0, -0.45);
  });

  const frameGeo = mergeParts(parts);
  const frameMat = new THREE.MeshStandardMaterial({
    color: FRAME_COLOUR,
    roughness: 0.55,
    metalness: 0.3,
  });
  const frame = new THREE.Mesh(frameGeo, frameMat);
  // The carbine casts; the racket does too, so first person - where the body
  // renders shadow-only - still shows a racket shadow instead of a gun's.
  frame.castShadow = true;
  frame.receiveShadow = false;

  // String bed: one elliptical fan just inside the hoop.
  const stringGeo = new THREE.CircleGeometry(1, 20);
  stringGeo.rotateX(-Math.PI / 2);
  stringGeo.scale(0.106, 1, 0.135);
  stringGeo.translate(0, 0, -0.45);
  const stringMat = new THREE.MeshBasicMaterial({
    color: STRING_COLOUR,
    transparent: true,
    opacity: 0.55,
    side: THREE.DoubleSide,
    // Translucent and thin: never worth a depth write, and skipping it avoids
    // sorting artifacts against the ball passing centimetres from the face.
    depthWrite: false,
  });
  const strings = new THREE.Mesh(stringGeo, stringMat);
  strings.castShadow = false;
  strings.receiveShadow = false;

  const object = new THREE.Group();
  object.name = 'racketProp';
  object.add(frame, strings);
  object.position.set(GRIP_POS[0], GRIP_POS[1], GRIP_POS[2]);
  object.rotation.set(GRIP_ROT[0], GRIP_ROT[1], GRIP_ROT[2]);

  return {
    object,
    dispose() {
      object.parent?.remove(object);
      frameGeo.dispose();
      frameMat.dispose();
      stringGeo.dispose();
      stringMat.dispose();
    },
  };
}

export default createRacket;
