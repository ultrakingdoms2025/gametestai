import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sweep, blob, blade } from '../gfx/Organic.js';

/**
 * Procedural quadruped bodies: the wolf and the bear.
 *
 * ── Why procedural, and why not the Humanoid factory ──────────────────────
 * Nothing in this project loads a model, and the one working quadruped it has -
 * `mounts/Horse.js` - is built the same way this is: a generalised cylinder
 * swept along a path, with the section changing as it goes (`gfx/Organic.js`).
 * That primitive is the correct description of a barrel, a neck, a muzzle, a
 * tail and every segment of every leg, and it gives a genuinely continuous
 * surface rather than a pile of primitives.
 *
 * `HumanoidFactory` cannot be asked to do this. It builds a biped from a skinned
 * mesh with a named bone list, and `NPCAnimator` drives that list by name with a
 * two-element `feet` array (see the antiphase literal at NPCAnimator.js:642).
 * There is no four-legged animal hiding in there.
 *
 * ── Reading a wolf from a bear at forty metres ────────────────────────────
 * The brief is that a player must tell them apart INSTANTLY at 40 m, which is
 * two hundred pixels of silhouette and no texture at all. Silhouette is
 * therefore the whole budget, and it is spent on four things:
 *
 *   1. **Height and mass.** 0.85 m at the shoulder against 1.40 m, and a barrel
 *      half-width of 0.21 against 0.38. The bear is not a big wolf; it is a
 *      different shape of animal.
 *   2. **The hump.** A bear's shoulder hump stands proud ABOVE its topline and
 *      is the tallest point of the animal - taller than its own head. Nothing
 *      else in the game has that profile.
 *   3. **The head carriage.** A wolf's skull is a long wedge carried level with
 *      the shoulder on a horizontal neck; a bear's is a short broad box carried
 *      well BELOW the hump on a neck that hangs down and forward.
 *   4. **The tail.** A brush that reaches the hock against a 15 cm stub.
 *
 * Everything else - fur colour, ear shape, paw size - is detail that only helps
 * once the player is already close.
 *
 * ── The interface this presents ───────────────────────────────────────────
 * `NPC` and `NPCManager` between them read exactly seven things off the body
 * they are handed: `root`, `height`, `heightScale`, `mesh`, `hairMesh`,
 * `getHeadWorldPosition`, `setDetailVisible` and `dispose`. This provides all of
 * them, plus `setShadowCasting`, which exists because a quadruped is a dozen
 * separate meshes and the manager's two-mesh shadow toggle cannot reach them.
 */

const TAU = Math.PI * 2;

/**
 * Shape profiles.
 *
 * Every number is metres in the animal's own space, with y = 0 at the ground
 * and -Z forward (the game's facing convention, so a beast's nose points the
 * same way as an NPC's does). Kept as data rather than as code so the two
 * species share one builder and so a third could be added without touching it.
 */
const PROFILES = {
  wolf: {
    height: 0.85,
    /* Barrel. Deepest just behind the shoulder, drawn in hard at the flank -
     * a wolf is a narrow animal and the tuck is most of what says so. */
    barrel: [
      { y: 0.66, z: -0.62, rx: 0.115, ry: 0.145 },   // point of the chest
      { y: 0.68, z: -0.50, rx: 0.180, ry: 0.215 },
      { y: 0.665, z: -0.32, rx: 0.205, ry: 0.245 },  // girth, deepest
      { y: 0.660, z: -0.08, rx: 0.185, ry: 0.215 },
      { y: 0.680, z: 0.14, rx: 0.158, ry: 0.180 },   // flank, tucked up
      { y: 0.700, z: 0.34, rx: 0.180, ry: 0.205 },
      { y: 0.710, z: 0.50, rx: 0.145, ry: 0.165 },   // croup
      { y: 0.700, z: 0.60, rx: 0.072, ry: 0.082 },   // dock
    ],
    /* Muscle masses, sized to finish flush with the barrel rather than to
     * stand off it - see the Horse.js note about balls stuck on the sides. */
    masses: [
      { r: [0.075, 0.095, 0.150], p: [-0.135, 0.655, -0.335] },   // shoulder
      { r: [0.075, 0.095, 0.150], p: [0.135, 0.655, -0.335] },
      { r: [0.082, 0.105, 0.160], p: [-0.108, 0.690, 0.360] },    // haunch
      { r: [0.082, 0.105, 0.160], p: [0.108, 0.690, 0.360] },
    ],
    /* A modest scruff over the withers. A wolf's raised hackles are a real
     * feature of the silhouette and cost one ellipsoid. */
    hump: { r: [0.085, 0.055, 0.170], p: [0, 0.745, -0.36] },
    neck: {
      at: [0, 0.735, -0.560],
      /* Nearly horizontal, reaching forward. A wolf carries its head level
       * with or below its shoulder; tilting this up turns it into a dog
       * begging, which is exactly wrong for something that is hunting you. */
      sections: [
        { y: -0.055, z: 0.115, rx: 0.170, ry: 0.190 },   // buried in the chest
        { y: -0.020, z: -0.060, rx: 0.140, ry: 0.155 },
        { y: 0.010, z: -0.235, rx: 0.112, ry: 0.125 },   // poll
      ],
    },
    head: {
      at: [0, 0.018, -0.268],
      /* Long wedge with a shallow stop. The muzzle is 40% of the skull's
       * length, which is the single measurement that separates a wolf's head
       * from a bear's. */
      sections: [
        { y: 0.020, z: 0.075, rx: 0.100, ry: 0.098 },   // back of the skull
        { y: 0.028, z: -0.020, rx: 0.108, ry: 0.102 },  // braincase
        { y: 0.004, z: -0.120, rx: 0.074, ry: 0.072 },  // stop
        { y: -0.014, z: -0.240, rx: 0.054, ry: 0.050 }, // muzzle
        { y: -0.024, z: -0.335, rx: 0.041, ry: 0.038 }, // nose
      ],
      cheeks: { r: [0.052, 0.056, 0.072], p: [0.066, -0.004, -0.058] },
      /* Erect and triangular, and set well back. Pinned flat when it is about
       * to bite - see `BeastAnimator`. */
      ear: { at: [0.062, 0.088, 0.038], len: 0.155, baseW: 0.085, tipW: 0.022,
             thick: 0.020, curve: -0.10, tilt: 0.30 },
      jaw: {
        at: [0, -0.030, -0.052],
        sections: [
          { y: 0, z: 0.02, rx: 0.060, ry: 0.038 },
          { y: -0.006, z: -0.110, rx: 0.048, ry: 0.032 },
          { y: -0.012, z: -0.230, rx: 0.036, ry: 0.024 },
          { y: -0.016, z: -0.290, rx: 0.028, ry: 0.019 },
        ],
        /* How far the jaw drops at full gape, radians. A wolf's gape is the
         * telegraph: the mouth opens on the lunge and shuts on the bite. */
        gape: 0.55,
      },
      /* Four canines, because a closed mouth at 3 m should still read as a
       * mouth full of teeth. `upperY` is in skull space and `lowerY` in jaw
       * space, so the gape opens the mouth rather than sliding the teeth
       * apart. */
      teeth: { x: 0.030, z: -0.195, upperY: -0.030, lowerY: 0.016, len: 0.034, r: 0.010 },
    },
    tail: {
      at: [0, 0.712, 0.585],
      /* A brush: thickest a third of the way down, not a rope. */
      sections: [
        { y: 0, z: 0, rx: 0.048, ry: 0.048 },
        { y: -0.055, z: 0.155, rx: 0.076, ry: 0.076 },
        { y: -0.135, z: 0.300, rx: 0.068, ry: 0.068 },
        { y: -0.230, z: 0.415, rx: 0.036, ry: 0.036 },
      ],
      hair: true,
    },
    legs: {
      track: 0.150,
      frontZ: -0.335,
      hindZ: 0.355,
      frontHipY: 0.620,
      hindHipY: 0.645,
      /* Long and lean. Almost all of the muscle is above the knee; below it a
       * wolf's leg is bone and tendon, which is what makes it look built for
       * running rather than for standing. */
      upperFront: [
        { y: 0.020, rx: 0.072, ry: 0.084 },
        { y: -0.130, rx: 0.058, ry: 0.066 },
        { y: -0.290, rx: 0.042, ry: 0.046 },
      ],
      upperHind: [
        { y: 0.030, rx: 0.086, ry: 0.100 },    // thigh, the pushing muscle
        { y: -0.120, rx: 0.070, ry: 0.082 },
        { y: -0.300, rx: 0.040, ry: 0.044 },
      ],
      kneeY: -0.300,
      lower: [
        { y: 0.010, rx: 0.038, ry: 0.042 },
        { y: -0.140, rx: 0.030, ry: 0.033 },
        { y: -0.280, rx: 0.030, ry: 0.033 },
      ],
      /* Digitigrade: a wolf stands on its toes, so the foot is a small compact
       * mass at the end of the cannon. */
      paw: { r: [0.044, 0.032, 0.062], p: [0, -0.302, -0.012] },
      pawGap: 0.014,
    },
    colours: {
      coat: [0x6b6259, 0x50494a, 0x7d7166, 0x3d3a38],
      belly: 0x9a9184,
      dark: 0x24211f,
      claw: 0x171514,
    },
    /* Anisotropic on purpose: a swept surface's UVs run once around the ring
     * and once along the length, so a single tile stretches one hair over the
     * whole animal. More repeats around than along also lays the grain the way
     * a coat actually lies - down and back. */
    fur: 'hide.fur:5,9',
  },

  bear: {
    height: 1.4,
    barrel: [
      { y: 1.000, z: -0.850, rx: 0.230, ry: 0.250 },  // point of the chest
      { y: 1.020, z: -0.620, rx: 0.330, ry: 0.350 },
      { y: 1.020, z: -0.360, rx: 0.375, ry: 0.395 },  // girth, deepest
      { y: 1.000, z: -0.050, rx: 0.365, ry: 0.375 },
      { y: 0.995, z: 0.300, rx: 0.355, ry: 0.355 },
      { y: 0.990, z: 0.600, rx: 0.310, ry: 0.310 },
      { y: 0.975, z: 0.820, rx: 0.170, ry: 0.180 },   // rump
    ],
    masses: [
      { r: [0.140, 0.170, 0.240], p: [-0.240, 1.055, -0.480] },  // shoulder
      { r: [0.140, 0.170, 0.240], p: [0.240, 1.055, -0.480] },
      { r: [0.150, 0.185, 0.250], p: [-0.215, 1.000, 0.520] },   // haunch
      { r: [0.150, 0.185, 0.250], p: [0.215, 1.000, 0.520] },
    ],
    /* THE HUMP. The mass of muscle over a bear's shoulder blades that drives
     * its forelegs, and the tallest point on the whole animal - taller than the
     * head it carries below it. At 40 m this one ellipsoid is most of what
     * says "bear" rather than "large dog". */
    hump: { r: [0.255, 0.235, 0.330], p: [0, 1.185, -0.520] },
    neck: {
      at: [0, 1.075, -0.780],
      /* Short, immensely thick, and angled DOWN. The head hangs off the front
       * of the chest below the hump; a bear that carries its head high reads as
       * a man in a suit. */
      sections: [
        { y: -0.030, z: 0.150, rx: 0.300, ry: 0.305 },  // buried in the chest
        { y: -0.095, z: -0.045, rx: 0.240, ry: 0.245 },
        { y: -0.160, z: -0.230, rx: 0.190, ry: 0.192 },
      ],
    },
    head: {
      at: [0, -0.180, -0.270],
      /* Short and broad. The muzzle is barely a quarter of the skull and the
       * braincase is nearly as wide as it is long. */
      sections: [
        { y: 0.030, z: 0.105, rx: 0.180, ry: 0.170 },   // back of the skull
        { y: 0.020, z: 0.000, rx: 0.196, ry: 0.185 },   // braincase, broad
        { y: -0.030, z: -0.135, rx: 0.140, ry: 0.132 }, // stop
        { y: -0.055, z: -0.240, rx: 0.112, ry: 0.104 }, // muzzle, short and thick
        { y: -0.068, z: -0.300, rx: 0.090, ry: 0.082 }, // nose
      ],
      cheeks: { r: [0.090, 0.092, 0.110], p: [0.115, -0.010, -0.070] },
      /* Small, round and set wide - the opposite of the wolf's erect wedges.
       * Built as a fat, barely-curved blade so it still has real thickness. */
      ear: { at: [0.145, 0.150, 0.055], len: 0.105, baseW: 0.115, tipW: 0.095,
             thick: 0.045, curve: 0.15, tilt: 0.55 },
      jaw: {
        at: [0, -0.062, -0.090],
        sections: [
          { y: 0, z: 0.03, rx: 0.105, ry: 0.055 },
          { y: -0.008, z: -0.130, rx: 0.090, ry: 0.048 },
          { y: -0.016, z: -0.260, rx: 0.070, ry: 0.038 },
          { y: -0.020, z: -0.320, rx: 0.052, ry: 0.030 },
        ],
        gape: 0.42,
      },
      teeth: { x: 0.058, z: -0.215, upperY: -0.068, lowerY: 0.026, len: 0.040, r: 0.014 },
    },
    tail: {
      /* A stub. Fifteen centimetres of it, and it is worth building purely so
       * that the absence of a brush is legible from behind. */
      at: [0, 1.040, 0.855],
      sections: [
        { y: 0, z: 0, rx: 0.058, ry: 0.058 },
        { y: -0.045, z: 0.075, rx: 0.052, ry: 0.052 },
        { y: -0.090, z: 0.120, rx: 0.030, ry: 0.030 },
      ],
      hair: false,
    },
    legs: {
      track: 0.300,
      frontZ: -0.500,
      hindZ: 0.520,
      frontHipY: 1.000,
      hindHipY: 0.980,
      /* Columns. A bear's legs are as thick at the ankle as a wolf's are at the
       * shoulder, and they are SHORT for the body they carry - the belly hangs
       * close to the ground, which is the second-best cue after the hump. */
      upperFront: [
        { y: 0.040, rx: 0.165, ry: 0.185 },
        { y: -0.230, rx: 0.145, ry: 0.155 },
        { y: -0.520, rx: 0.120, ry: 0.126 },
      ],
      upperHind: [
        { y: 0.050, rx: 0.180, ry: 0.200 },
        { y: -0.220, rx: 0.155, ry: 0.168 },
        { y: -0.520, rx: 0.118, ry: 0.124 },
      ],
      kneeY: -0.520,
      lower: [
        { y: 0.010, rx: 0.118, ry: 0.124 },
        { y: -0.200, rx: 0.110, ry: 0.116 },
        { y: -0.400, rx: 0.108, ry: 0.114 },
      ],
      /* Plantigrade: a bear walks on the soles of its feet, so the paw is a
       * broad flat plate rather than the wolf's compact ball. */
      paw: { r: [0.125, 0.052, 0.190], p: [0, -0.428, -0.048] },
      pawGap: 0.012,
    },
    colours: {
      coat: [0x4a3527, 0x36271d, 0x5d4530, 0x2b2019],
      belly: 0x3a2b20,
      dark: 0x1a1310,
      claw: 0xd8cbb0,
    },
    fur: 'hide.fur:4,8',
  },
};

/** Merge a list of geometries into one, disposing the parts. */
function merge(list) {
  const clean = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const m = mergeGeometries(clean, false);
  for (const g of clean) g.dispose();
  return m;
}

/** `blob` from a `{r:[x,y,z], p:[x,y,z]}` record, optionally mirrored in x. */
function massGeo(m, sign = 1, seg = 12) {
  return blob(m.r[0], m.r[1], m.r[2], m.p[0] * sign, m.p[1], m.p[2], seg);
}

export class BeastBody {
  /**
   * @param {{species:string, materials?:any, seed?:number}} ctx
   */
  constructor({ species = 'wolf', materials = null, seed = 1 }) {
    this.species = PROFILES[species] ? species : 'wolf';
    this.profile = PROFILES[this.species];
    this.materials = materials;
    this._owned = [];

    let s = (seed >>> 0) || 5;
    this._rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    /* Warm the generator up before anything reads it.
     *
     * A linear congruential generator's FIRST output is very nearly linear in
     * its seed - consecutive seeds differ by about a four-thousandth - so a
     * caller that seeds a pack with 1, 2, 3, 4, 5 gets five animals of
     * identical size. Three throwaway draws multiply the difference by the
     * multiplier cubed and the sizes separate properly. Costs three
     * multiplications, once, at build time. */
    this._rnd();
    this._rnd();
    this._rnd();

    /**
     * Size jitter. A pack of five identical wolves reads as five copies of one
     * wolf, which is a stronger cue than any amount of coat variation - so the
     * scale moves before the colour does.
     */
    this.heightScale = 0.9 + this._rnd() * 0.2;
    this.height = this.profile.height * this.heightScale;

    /** Every mesh that can cast, so the LOD band can reach all of them. */
    this._casters = [];
    /** Small parts culled at distance: teeth, claws, eyes. */
    this._detail = [];

    this._build();
  }

  /**
   * A surface for this animal.
   *
   * Same approach as `Horse._mat`: clone the shared PBR instance so the coat
   * takes its grain from the bake and its colour from here, and every clone
   * shares the same GPU texture storage. Falls through to a flat standard
   * material when there is no library - which is what happens under `node
   * --test`, and is why the body can be built headless at all.
   */
  _mat(color, opts = {}) {
    const { surface = null, ...rest } = opts;
    if (surface && this.materials?.get) {
      try {
        const base = this.materials.get(surface);
        if (base) {
          const m = base.clone();
          m.color = new THREE.Color(color);
          if (rest.roughness !== undefined) m.roughness = rest.roughness;
          if (rest.metalness !== undefined) m.metalness = rest.metalness;
          this._owned.push(m);
          return m;
        }
      } catch {
        /* fall through to the flat material below */
      }
    }
    const m = new THREE.MeshStandardMaterial({
      color: new THREE.Color(color),
      roughness: rest.roughness ?? 0.88,
      metalness: rest.metalness ?? 0.02,
      ...rest,
    });
    this._owned.push(m);
    return m;
  }

  /** Add a mesh, own its geometry, and file it as a shadow caster. */
  _add(parent, geo, mat, { cast = true, detail = false } = {}) {
    this._owned.push(geo);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.castShadow = cast;
    mesh.receiveShadow = true;
    parent.add(mesh);
    if (cast) this._casters.push(mesh);
    if (detail) this._detail.push(mesh);
    return mesh;
  }

  _build() {
    const P = this.profile;
    const C = P.colours;

    this.root = new THREE.Group();
    this.root.name = `beast:${this.species}`;
    // One scale node so the size jitter never has to be applied part by part -
    // and so the AI can keep working in profile metres while the mesh is 10%
    // bigger than the table says.
    this.scaleNode = new THREE.Group();
    this.scaleNode.scale.setScalar(this.heightScale);
    this.root.add(this.scaleNode);
    /* Pitch and roll live under the scale node so the legs, which hang off the
     * body, inherit the body's attitude for free - the same trick Horse.js
     * uses and for the same reason. */
    this.tilt = new THREE.Group();
    this.scaleNode.add(this.tilt);

    const coatColour = C.coat[(this._rnd() * C.coat.length) | 0];
    const coat = this._mat(coatColour, { surface: P.fur });
    const belly = this._mat(C.belly, { surface: P.fur, roughness: 0.92 });
    const dark = this._mat(C.dark, { roughness: 0.7 });
    const claw = this._mat(C.claw, { roughness: 0.35, metalness: 0.1 });
    this.materialSet = { coat, belly, dark, claw };

    /* ---- barrel: one merged, continuous mass ---- */
    const bodyParts = [sweep(P.barrel, 18)];
    for (const m of P.masses) bodyParts.push(massGeo(m, 1));
    if (P.hump) bodyParts.push(massGeo(P.hump, 1, 14));
    const bodyMesh = this._add(this.tilt, merge(bodyParts), coat);
    /** The manager's LOD and the combat flash both look for this. */
    this.mesh = bodyMesh;
    /** No separate hair mesh on a quadruped; the field exists for the callers. */
    this.hairMesh = null;

    /* ---- neck + head ---- */
    this.neck = new THREE.Group();
    this.neck.position.set(...P.neck.at);
    this.tilt.add(this.neck);
    this._add(this.neck, sweep(P.neck.sections, 16, { capStart: false }), coat);

    this.head = new THREE.Group();
    this.head.position.set(...P.head.at);
    this.neck.add(this.head);
    this._add(
      this.head,
      merge([
        sweep(P.head.sections, 16),
        massGeo(P.head.cheeks, -1, 10),
        massGeo(P.head.cheeks, 1, 10),
      ]),
      coat
    );

    /* Eyes: two dark beads. Six triangles' worth of geometry that does more
     * for "this thing is looking at me" than the whole skull does. */
    const eyeGeo = merge([
      blob(0.017, 0.017, 0.014, -P.head.cheeks.p[0] * 0.62, P.head.cheeks.p[1] + 0.038,
        P.head.sections[2].z + 0.02, 8),
      blob(0.017, 0.017, 0.014, P.head.cheeks.p[0] * 0.62, P.head.cheeks.p[1] + 0.038,
        P.head.sections[2].z + 0.02, 8),
    ]);
    this._add(this.head, eyeGeo, dark, { cast: false, detail: true });

    /* ---- ears, on their own pivots ----
     * Two nodes, and they carry more of the animal's state than anything else
     * on it: pinned flat as it commits to a charge, forward and flicking at
     * rest. A predator whose ears never move is a statue of a predator. */
    this.ears = [];
    const E = P.head.ear;
    for (const side of [-1, 1]) {
      const pivot = new THREE.Group();
      pivot.position.set(E.at[0] * side, E.at[1], E.at[2]);
      pivot.rotation.z = -side * E.tilt;
      this.head.add(pivot);
      // `blade` sweeps along -Z and droops in -Y; a quarter turn about X
      // stands it up so the ear points at the sky instead of at the nose.
      const g = blade(E.len, E.baseW, E.tipW, E.thick, E.curve, 4);
      g.rotateX(Math.PI * 0.5);
      this._add(pivot, g, coat);
      this.ears.push(pivot);
    }

    /* ---- jaw ----
     * A separate pivot under the skull. The gape IS the telegraph: it opens
     * through the wind-up and snaps shut on the strike, so a player who is
     * looking at the animal can read the bite before it lands. */
    const J = P.head.jaw;
    this.jaw = new THREE.Group();
    this.jaw.position.set(...J.at);
    this.head.add(this.jaw);
    this.jawGape = J.gape;
    this._add(this.jaw, sweep(J.sections, 12, { capStart: false }), coat);

    /* Canines, top and bottom. Built into the skull and the jaw respectively
     * so the gape opens the mouth rather than sliding the teeth apart. */
    const T = P.head.teeth;
    const tooth = (sign, baseY, dir) => sweep([
      { x: T.x * sign, y: baseY, z: T.z, rx: T.r, ry: T.r },
      { x: T.x * sign * 0.94, y: baseY + T.len * dir, z: T.z - T.len * 0.25,
        rx: T.r * 0.22, ry: T.r * 0.22 },
    ], 6, { capStart: false });
    this._add(this.head, merge([tooth(-1, T.upperY, -1), tooth(1, T.upperY, -1)]),
      claw, { cast: false, detail: true });
    this._add(this.jaw, merge([tooth(-1, T.lowerY, 1), tooth(1, T.lowerY, 1)]),
      claw, { cast: false, detail: true });

    /* ---- tail ---- */
    this.tail = new THREE.Group();
    this.tail.position.set(...P.tail.at);
    this.tilt.add(this.tail);
    this._add(this.tail, sweep(P.tail.sections, 12, { capStart: false }),
      P.tail.hair ? this._mat(coatColour, { surface: P.fur, roughness: 0.96 }) : coat);

    /* ---- legs ----
     * Order is [FL, FR, HL, HR] to match `BeastGait`'s phase tables. Two
     * segments each, so the knee and the hock can actually fold - a rigid leg
     * swinging from the shoulder reads as a table being dragged. */
    this.legs = [];
    const L = P.legs;
    const spec = [
      { x: -L.track, z: L.frontZ, front: true },
      { x: L.track, z: L.frontZ, front: true },
      { x: -L.track, z: L.hindZ, front: false },
      { x: L.track, z: L.hindZ, front: false },
    ];
    for (const s of spec) {
      const hipY = s.front ? L.frontHipY : L.hindHipY;
      const upper = new THREE.Group();
      upper.position.set(s.x, hipY, s.z);
      this.tilt.add(upper);
      this._add(upper, sweep(
        (s.front ? L.upperFront : L.upperHind).map((k) => ({ y: k.y, z: 0, rx: k.rx, ry: k.ry })),
        12, { capStart: false }
      ), coat);

      const lower = new THREE.Group();
      lower.position.set(0, L.kneeY, 0);
      upper.add(lower);
      this._add(lower, merge([
        sweep(L.lower.map((k) => ({ y: k.y, z: 0, rx: k.rx, ry: k.ry })), 12, { capStart: false }),
        blob(L.paw.r[0], L.paw.r[1], L.paw.r[2], L.paw.p[0], L.paw.p[1], L.paw.p[2], 10),
      ]), coat);

      // Claws: four short spikes off the front of the paw.
      const claws = [];
      for (let i = 0; i < 4; i++) {
        const cx = (i - 1.5) * L.paw.r[0] * 0.52;
        claws.push(sweep([
          { x: cx, y: L.paw.p[1], z: L.paw.p[2] - L.paw.r[2] * 0.7, rx: L.pawGap, ry: L.pawGap },
          { x: cx, y: L.paw.p[1] - L.pawGap * 0.6, z: L.paw.p[2] - L.paw.r[2] * 1.25,
            rx: L.pawGap * 0.25, ry: L.pawGap * 0.25 },
        ], 5, { capStart: false }));
      }
      this._add(lower, merge(claws), claw, { cast: false, detail: true });

      this.legs.push({
        upper, lower, front: s.front, side: Math.sign(s.x) || 1,
        hipY, prevT: 0,
      });
    }

    /**
     * Where the mouth is, in body space. The maul's contact volume starts here
     * and the AI measures its reach from here, so it is derived from the built
     * skeleton rather than guessed - a reshaped head moves the bite with it.
     */
    const muzzleY = P.neck.at[1] + P.head.at[1] + P.head.sections[3].y;
    const muzzleZ = P.neck.at[2] + P.head.at[2] + P.head.sections[3].z;
    this.muzzleLocal = new THREE.Vector3(0, muzzleY, muzzleZ).multiplyScalar(this.heightScale);

    /** Nose to dock, for the manager's cheap hit-rejection sphere. */
    this.bodyLength = (P.barrel[P.barrel.length - 1].z - muzzleZ) * this.heightScale;

    this._head3 = new THREE.Vector3();
  }

  /* ---------------------------------------------------------------- */
  /* The interface NPC / NPCManager read                               */
  /* ---------------------------------------------------------------- */

  /**
   * World-space centre of the skull.
   *
   * `NPCManager.raycastNPCs` treats this as the headshot sphere, and the AI
   * uses it as the eye point for line-of-sight - so on a quadruped it has to
   * be the actual head hanging out in front of the body, not a point above the
   * root. That is the whole reason this is a matrix lookup rather than
   * `position.y + height`.
   */
  getHeadWorldPosition(out) {
    this.root.updateWorldMatrix(true, false);
    this.head.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.head.matrixWorld);
  }

  /** Small parts (eyes, teeth, claws) are not worth drawing at distance. */
  setDetailVisible(v) {
    if (this._detailVisible === v) return;
    this._detailVisible = v;
    for (const m of this._detail) m.visible = v;
  }

  /**
   * Shadow LOD for a body made of a dozen meshes.
   *
   * `NPCManager._updateLOD` toggles `humanoid.mesh` and `humanoid.hairMesh`,
   * which is the whole of a humanoid and about a tenth of a beast. It calls
   * this instead when a body offers it, so a wolf's legs stop casting at the
   * same distance its barrel does.
   */
  setShadowCasting(on) {
    if (this._casting === on) return;
    this._casting = on;
    for (const m of this._casters) m.castShadow = on;
  }

  dispose() {
    for (const o of this._owned) o.dispose?.();
    this._owned.length = 0;
    this._casters.length = 0;
    this._detail.length = 0;
    this.root.clear();
  }
}

export { PROFILES as BEAST_PROFILES, TAU };
