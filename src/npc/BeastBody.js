import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sweep, blob, blade } from '../gfx/Organic.js';
import { beastParts } from '../worlds/medieval/BeastAssets.js';

/**
 * Procedural quadruped bodies: the wolf, the bear and the camel.
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
 * The camel is the third silhouette and it is the easiest of the three, because
 * it is separated from both predators by HEIGHT and by HEAD CARRIAGE before any
 * other cue gets a chance: 2.20 m at the hump against a bear's 1.40, and a head
 * carried at 2.69 m on 1.32 m of near-vertical neck - ABOVE its own hump, where
 * a bear's hangs below. See the note on its profile.
 *
 * The camel is also the one animal here that is NOT built from an ellipse swept
 * along a path. It was, and at close range it read as the pile of primitives it
 * was: a sphere on a tube on four rods. Its body is now a single lofted
 * superellipse - @see `loft` - and the reasoning is on the profile.
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

  /**
   * CAMEL - a dromedary, and the place where this parameterisation ran out.
   *
   * -- THE FIRST VERSION, AND WHY IT WAS REBUILT -----------------------------
   * The camel first shipped as `barrel` + `hump` + `masses` + two-station legs,
   * exactly like the wolf and the bear, on the argument that a single-hump
   * profile was what the `hump` field already described. The silhouette that
   * came out of that was right and the animal was not. From three metres it read
   * as what it was: a SPHERE resting on a tube, on four rods. Four faults, and
   * every one of them a consequence of building a 2.2 m animal out of parts that
   * work at 0.85 m.
   *
   *   1. The hump was a separate closed surface merged into another one, and a
   *      merge is not a join - the intersection is visible from anywhere.
   *   2. There was no ribcage worth the name between the legs: an ellipse
   *      0.490 m wide under 1.400 m of leg, with a round underside.
   *   3. The legs were cones of even taper, with the muscle left behind on the
   *      barrel as two 0.085 m ellipsoids that were invisible beside them, and a
   *      knee narrower than both bones it joined.
   *   4. The neck was a tube of near-constant thickness meeting the chest at a
   *      hard circle.
   *
   * The fix for the first two is one idea: the body is a `hull`, lofted from a
   * superellipse whose shape changes along the length (@see `loft`), so the hump
   * is made of the same skin as the back and the section can be keeled,
   * slab-sided and deep all at once. The fix for the last two is to move each
   * mass into the part that owns it - the shoulder into the foreleg, the thigh
   * into the hind leg, the withers into the base of the neck.
   *
   * The wolf and the bear were not touched. They still take the `barrel` arm of
   * `_build`, and `camel.test.mjs` pins SHA-256 over their spec rows, their gait
   * tables, their built vertices at three seeds and 600 posed frames.
   *
   * -- THE FIELDS THAT ARE NOT ON THE OTHER TWO ------------------------------
   *   - `hull` instead of `barrel` + `hump`. @see `loft`.
   *   - `head.eye`, because the eye beads are derived from `cheeks` by default
   *     and a camel's eyes are set higher and further out on a much narrower
   *     skull than that expression can reach. Big dark eyes are most of what
   *     stops a camel's small head reading as a blank peg at close range.
   *   - `legs.clawCount`, because a camel has TWO toenails, not four claws.
   *
   * Both of the last two default to the expression they replace, which is what
   * lets the two predators come out of the builder bit-for-bit as they did.
   *
   * -- READING A CAMEL AT FORTY METRES ---------------------------------------
   * The same budget as the wolf and the bear - silhouette only - spent on four
   * things, none of which any other animal in this game has:
   *
   *   1. HEIGHT. 2.20 m at the hump against a bear's 1.40 and a player's 1.75.
   *      It is the tallest thing that walks in this world, and it is the first
   *      thing that reads.
   *   2. THE NECK. 1.32 m of it, rising almost vertically out of the withers and
   *      arching forward at the top, carrying the head at 2.69 m - ABOVE the
   *      hump. A bear's head hangs below its hump and a wolf's is level with its
   *      shoulder; a camel's is the highest point on the animal. Nothing else
   *      here has that profile and nothing else can be mistaken for it.
   *   3. THE HUMP. One, mid-back, 0.400 m of rise above the withers, and 0.229 m
   *      across near its top on a back 0.504 m across - a mound standing on the
   *      body rather than a thickening of it.
   *   4. THE LEGS. Long, and finishing in a flat splayed pad rather than a paw.
   *      A camel's belly clears 1.145 m at the keel and 1.324 m at the haunch; a
   *      bear's is 0.625.
   *
   * -- AND AT THREE METRES ----------------------------------------------------
   * A different set of facts has to carry it, and they are the ones the rebuild
   * is actually made of: a chest that hangs 0.315 m below the shoulder joint the
   * forelegs swing from, a shoulder and a thigh standing 0.042 m and 0.062 m
   * proud of the ribs, knees and hocks that are knobs twice the width of the
   * cannon, and a sternal pad. Each of those is MEASURED in `camel.test.mjs`,
   * because "it looks better" is not a test.
   *
   * Every y below is metres above the ground with the animal standing, so the
   * foot pads finish at y = 0 and the root can be dropped straight onto the
   * terrain. -Z is forward, as everywhere else in this file.
   */
  camel: {
    /* The crest of the hump, and the same number as `BEASTS.camel.
     * shoulderHeight` - `NPC` reads `humanoid.height` for its collision capsule
     * and `beast-body` asserts the two agree. The head stands 0.49 m higher
     * still, which is the point of the animal. */
    height: 2.2,
    /**
     * THE HULL. One lofted surface from the brisket to the dock, built by
     * `loft` above rather than by `sweep`, and it is the whole of the body:
     * chest, ribcage, belly, back, croup AND hump, with no seam anywhere on it.
     *
     * -- WHY THIS IS NOT A `barrel` -------------------------------------------
     * The camel that shipped had `barrel` + `hump`, an ellipse with a sphere
     * merged into it, and close up it read as exactly that: a ball resting on a
     * tube. Every fault in it came from the ellipse:
     *
     *   - a hump that was a separate object with a visible intersection;
     *   - a barrel 0.490 m wide under a back carrying 1.400 m of leg, which is a
     *     rod, so the animal read as a ball on stilts;
     *   - a round underside, where a dromedary's chest is a KEEL;
     *   - a flat disc across the front, because collapsing a full-width section
     *     to its centre is a fan and not a dome.
     *
     * -- HOW TO READ A STATION ------------------------------------------------
     * `z` along the spine, -Z forward. `y` is the height of the WAIST - the
     * widest line of the section, which on a barrel-chested animal is well above
     * the middle of it. `top` and `bot` are absolute heights of the topline and
     * the underline. `hw` is the half-width at the waist. `ex`, `et` and `eb`
     * are the three shape exponents documented on `loft`.
     *
     * The table is dense on purpose - sixteen stations, and eight of them over
     * the metre of back the hump occupies - because the hump's profile along the
     * body is a curve, and a curve read from four stations is a tent. Every
     * `top` here is a smooth backline plus a quartic bell 0.498 m high centred
     * at z = -0.030 with a half-length of 0.560 m; every `et` is 1.10 plus 0.30
     * of the same bell. That is why the numbers are not round.
     *
     * -- THE FOUR THINGS THE NUMBERS ARE DOING --------------------------------
     *   1. THE HUMP is `top` climbing from 1.800 at the withers to 2.200 over
     *      the middle of the back and falling to 1.778 at the croup - 0.400 m of
     *      rise - with `et` climbing 1.10 -> 1.40 alongside it so the section
     *      NARROWS as it rises. At the crest the back is 0.504 m across at the
     *      waist and 0.229 m across at 90% of the rise: the hump stands on the
     *      back rather than swelling it.
     *   2. THE KEEL is `bot` at 1.145 under the girth against 1.324 at the
     *      haunch, with `eb` at 1.55 through the chest so the underside comes to
     *      a rounded edge rather than to the bottom of a circle. The deepest
     *      point of the chest is 0.315 m BELOW the shoulder joint the forelegs
     *      swing from, which is what "the chest hangs below the shoulder line"
     *      means as a number. The section is 0.655 m top to bottom - the same
     *      ribcage depth the ellipse had. The depth never was the problem; the
     *      shape of it was.
     *   3. THE SLAB SIDES are `ex` at 0.80 from shoulder to flank, which holds
     *      the flank at 96.7% of full width a quarter of the way up towards the
     *      topline where an ellipse is down to 87%. Total width at the girth is
     *      0.620 m against the ellipse's 0.490.
     *   4. THE ENDS are stations 1 and 16, drawn 0.030 m in half-width, so the
     *      fan that closes each end is 3 cm across and cannot be seen.
     */
    hull: [
      { z: -1.020, y: 1.495, hw: 0.030, top: 1.570, bot: 1.445, ex: 1.00, et: 1.10, eb: 1.00 },
      { z: -0.980, y: 1.487, hw: 0.105, top: 1.684, bot: 1.288, ex: 0.97, et: 1.10, eb: 1.25 },
      // brisket
      { z: -0.905, y: 1.491, hw: 0.162, top: 1.762, bot: 1.205, ex: 0.90, et: 1.10, eb: 1.45 },
      { z: -0.780, y: 1.497, hw: 0.232, top: 1.791, bot: 1.160, ex: 0.86, et: 1.10, eb: 1.49 },
      // withers, widest section on the animal
      { z: -0.620, y: 1.505, hw: 0.310, top: 1.800, bot: 1.145, ex: 0.80, et: 1.10, eb: 1.55 },
      { z: -0.470, y: 1.507, hw: 0.296, top: 1.851, bot: 1.156, ex: 0.80, et: 1.14, eb: 1.49 },
      { z: -0.330, y: 1.508, hw: 0.279, top: 1.996, bot: 1.168, ex: 0.80, et: 1.25, eb: 1.44 },
      { z: -0.190, y: 1.510, hw: 0.264, top: 2.136, bot: 1.189, ex: 0.80, et: 1.35, eb: 1.34 },
      // HUMP CREST
      { z: -0.030, y: 1.512, hw: 0.252, top: 2.200, bot: 1.213, ex: 0.80, et: 1.40, eb: 1.24 },
      { z: 0.130, y: 1.517, hw: 0.247, top: 2.134, bot: 1.252, ex: 0.80, et: 1.35, eb: 1.17 },
      // flank
      { z: 0.290, y: 1.522, hw: 0.243, top: 1.981, bot: 1.294, ex: 0.80, et: 1.24, eb: 1.11 },
      // haunch
      { z: 0.450, y: 1.528, hw: 0.292, top: 1.832, bot: 1.324, ex: 0.81, et: 1.12, eb: 1.12 },
      { z: 0.620, y: 1.545, hw: 0.272, top: 1.797, bot: 1.359, ex: 0.85, et: 1.10, eb: 1.14 },
      // croup
      { z: 0.790, y: 1.567, hw: 0.201, top: 1.778, bot: 1.410, ex: 0.89, et: 1.10, eb: 1.10 },
      // dock
      { z: 0.910, y: 1.598, hw: 0.112, top: 1.736, bot: 1.485, ex: 0.95, et: 1.10, eb: 1.04 },
      { z: 0.985, y: 1.622, hw: 0.030, top: 1.660, bot: 1.580, ex: 1.00, et: 1.10, eb: 1.00 },
    ],
    /* THE STERNAL PAD. A dromedary kneels on a horn callus under its breastbone,
     * and the pad is a real, visible lump - the one thing on a camel's underside
     * you can name from ten metres. Centred on x = 0, so the one pass in
     * `_build` builds it once. It is the only mass this animal has: the shoulder
     * and haunch masses the wolf and the bear carry are gone, because on this
     * body they are IN the leg (see `upperFront` / `upperHind`), which is where
     * a muscle that drives a limb belongs. */
    masses: [
      { r: [0.088, 0.058, 0.130], p: [0, 1.180, -0.742] },
    ],
    /* No `hump` field. It IS the back. @see `hull` above. */
    neck: {
      at: [0, 1.615, -0.760],
      /* THE S, and the taper.
       *
       * Seven stations. The base ring is 0.228 m in half-width and sits at
       * (0, 1.445, -0.580), which is 0.30 m inside the underline of a chest
       * 0.310 m wide - so the neck grows out of the withers instead of being
       * planted on them. The taper is 0.228 -> 0.185 -> 0.150 over the first
       * 0.345 m of a 1.319 m run: 55% of all the narrowing in the first 26% of
       * the length, which is a wedge. A cone tapers evenly and meets a body at
       * the same hard circle a cylinder does, and that circle was the fault the
       * shipped animal wore most plainly.
       *
       * Then up, almost vertically, and arching forward over the last third.
       * The poll finishes 1.155 m above the base and 0.575 m in front of it, and
       * carries the head at 2.690 m - 0.490 m above the crest of the hump. */
      sections: [
        { y: -0.170, z: 0.180, rx: 0.228, ry: 0.268 },  // buried in the chest
        { y: -0.075, z: 0.115, rx: 0.185, ry: 0.225 },  // the withers swell
        { y: 0.130, z: 0.010, rx: 0.150, ry: 0.178 },   // clear of the shoulder
        { y: 0.365, z: -0.055, rx: 0.126, ry: 0.148 },
        { y: 0.605, z: -0.105, rx: 0.111, ry: 0.130 },  // crest of the S
        { y: 0.815, z: -0.215, rx: 0.099, ry: 0.114 },
        { y: 0.985, z: -0.395, rx: 0.086, ry: 0.098 },  // poll
      ],
    },
    head: {
      at: [0, 1.075, -0.480],
      /* Small, narrow, and long in the muzzle - a camel's skull is 2.4 times as
       * long as it is wide against a wolf's 1.9 and a bear's 1.0. The last
       * station drops away: the upper lip hangs, which along with the eyes is
       * the whole of a camel's expression. */
      sections: [
        { y: 0.010, z: 0.070, rx: 0.078, ry: 0.086 },   // back of the skull
        { y: 0.020, z: -0.010, rx: 0.086, ry: 0.092 },  // braincase, small
        { y: -0.020, z: -0.120, rx: 0.062, ry: 0.070 }, // stop
        { y: -0.070, z: -0.250, rx: 0.055, ry: 0.062 }, // muzzle
        { y: -0.105, z: -0.335, rx: 0.048, ry: 0.052 }, // the hanging lip
      ],
      cheeks: { r: [0.040, 0.048, 0.060], p: [0.052, -0.010, -0.050] },
      /* Set high and WIDE, and standing proud of a skull that is only 0.086 m
       * in half-width at that station - the beads poke out either side rather
       * than sitting in the surface. This is what `head.eye` exists for. */
      eye: { x: 0.070, y: 0.045, z: -0.070, r: 0.024, rz: 0.020 },
      /* Small, rounded and set far back - closer to the bear's than the wolf's,
       * but half the size and tipped further out. */
      ear: { at: [0.062, 0.062, 0.055], len: 0.085, baseW: 0.070, tipW: 0.030,
             thick: 0.024, curve: 0.10, tilt: 0.62 },
      jaw: {
        at: [0, -0.052, -0.095],
        sections: [
          { y: 0, z: 0.02, rx: 0.048, ry: 0.032 },
          { y: -0.010, z: -0.110, rx: 0.042, ry: 0.028 },
          { y: -0.024, z: -0.225, rx: 0.036, ry: 0.024 },
          { y: -0.034, z: -0.300, rx: 0.030, ry: 0.020 },
        ],
        /* Small. On a predator the gape is the telegraph and it is driven by
         * the wind-up; a camel has no wind-up, so this is only ever driven by
         * the chew `BeastAnimator` gives a resting herbivore. */
        gape: 0.30,
      },
      /* Camels do have canines - the tusks a bull shows when it is annoyed -
       * and they are the same four spikes every other row builds, an order of
       * magnitude smaller. */
      teeth: { x: 0.024, z: -0.170, upperY: -0.028, lowerY: 0.014, len: 0.024, r: 0.007 },
    },
    tail: {
      at: [0, 1.632, 0.960],
      /* A thin rope with a tuft on the end, half a metre of it. The tuft is one
       * fat station: it is the only part of the tail that is visible at any
       * distance and without it a camel's rear reads as a bear's. */
      sections: [
        { y: 0, z: 0, rx: 0.042, ry: 0.045 },
        { y: -0.150, z: 0.075, rx: 0.030, ry: 0.032 },
        { y: -0.330, z: 0.105, rx: 0.024, ry: 0.026 },
        { y: -0.470, z: 0.120, rx: 0.040, ry: 0.042 },  // the tuft
        { y: -0.545, z: 0.125, rx: 0.014, ry: 0.015 },
      ],
      hair: true,
    },
    legs: {
      /* Narrow-tracked, which is the other half of why a pacing camel rolls:
       * the feet fall almost under the centre line, so there is nothing much
       * holding the body up sideways when one side lifts. */
      track: 0.185,
      frontZ: -0.620,
      hindZ: 0.520,
      /* Both hips at the same height, so both pairs of feet finish at exactly
       * y = 0: 1.46 - 0.66 (knee) - 0.745 (pad centre) - 0.055 (pad half-depth). */
      frontHipY: 1.460,
      hindHipY: 1.460,
      /**
       * THE LEG IS THE MUSCLE.
       *
       * The wolf and the bear carry their shoulder and haunch as ellipsoids
       * merged into the barrel, and on a 0.85 m animal that works. On a camel it
       * did not: the legs left the body at 0.098 m of half-width, dead straight,
       * and the two shoulder ellipsoids were 0.085 m lumps lost against a 0.245 m
       * barrel - which is why the shipped animal read as four rods pushed into a
       * tube.
       *
       * So the mass moved into the limb that uses it. Six stations, not three:
       *
       *   y = +0.155  a 0.030 m tip, deep INSIDE the body wall. The ring is
       *               open here (`capStart: false`) so the hull has to swallow
       *               it, which is why the withers and haunch stations are drawn
       *               0.310 and 0.292 wide - the widest sections on the animal -
       *               and why `camel.test.mjs` measures every open ring against
       *               the hull's own cross-section rather than trusting this.
       *               It is a TIP and not a wide ring on purpose: the limb has
       *               to come out of the body as a dome, because a cone that
       *               crosses the skin at a shallow angle leaves a spike
       *               standing on the shoulder, which is what the first attempt
       *               at this did.
       *   y = -0.060  the shoulder / thigh, 0.140 and 0.148 of half-width and
       *               standing PROUD of the ribs by 0.042 m at the front and
       *               0.062 m at the back. That is a muscle, and because it
       *               belongs to the limb it swings with the limb - which is
       *               also where a muscle that drives a limb should be.
       *   y = -0.360  forearm / gaskin, a bit over half the thickness.
       *   y = -0.660  0.054 at the knee: a quarter of the width at the shoulder,
       *               and that taper is the whole of "heavy thigh, thin cannon".
       *
       * The hind is heavier than the fore at every station above the hock, which
       * is the ordinary quadruped arrangement and reads at any distance where
       * the animal is more than a brush stroke wide: the drive is behind.
       */
      upperFront: [
        { y: 0.120, rx: 0.030, ry: 0.032 },    // the tip, deep inside the chest
        { y: 0.045, rx: 0.076, ry: 0.080 },
        { y: -0.060, rx: 0.140, ry: 0.132 },   // shoulder, proud of the ribs
        { y: -0.190, rx: 0.126, ry: 0.130 },   // upper arm
        { y: -0.360, rx: 0.080, ry: 0.088 },   // forearm
        { y: -0.530, rx: 0.061, ry: 0.066 },
        { y: -0.660, rx: 0.054, ry: 0.058 },   // above the knee
      ],
      upperHind: [
        { y: 0.120, rx: 0.028, ry: 0.030 },    // the tip, deep inside the flank
        { y: 0.040, rx: 0.080, ry: 0.084 },
        { y: -0.070, rx: 0.148, ry: 0.140 },   // THE THIGH, the heaviest mass
        { y: -0.200, rx: 0.132, ry: 0.138 },
        { y: -0.380, rx: 0.086, ry: 0.096 },   // gaskin
        { y: -0.540, rx: 0.063, ry: 0.069 },
        { y: -0.660, rx: 0.056, ry: 0.060 },   // above the hock
      ],
      kneeY: -0.660,
      /**
       * THE KNEE AND THE CANNON.
       *
       * Station 2 is a knob 0.140 m across on a cannon 0.066 m across - the
       * carpus in front and the hock behind, and on a camel both are genuinely
       * knobbly, calloused, and wider than the leg they interrupt. The shipped
       * leg had 0.045 here under an upper that finished at 0.048: a joint
       * narrower than both bones it joins, which is a rod with a crimp in it.
       * It sits at y = -0.010, a centimetre from the joint it turns about, so
       * folding the knee rotates the knob about its own centre instead of
       * swinging it out sideways.
       *
       * Station 1 is 0.052 against the 0.054 and 0.056 the uppers finish at: the
       * open ring is a hair narrower than the tube above it and is therefore
       * inside it, and the upper's end fan is inside the knob. Neither hole can
       * be reached by a camera.
       */
      lower: [
        { y: 0.055, rx: 0.052, ry: 0.056 },    // hidden inside the upper
        { y: -0.010, rx: 0.070, ry: 0.078 },   // THE KNEE / HOCK
        { y: -0.090, rx: 0.048, ry: 0.052 },
        { y: -0.330, rx: 0.034, ry: 0.036 },   // cannon, the thinnest bone here
        { y: -0.560, rx: 0.033, ry: 0.035 },
        { y: -0.680, rx: 0.042, ry: 0.045 },   // fetlock, swelling into the pad
      ],
      /* THE SPLAYED FOOT. Not a paw: a broad flat pad, 0.34 m across and 0.11 m
       * deep, that spreads on sand. The measurement that actually reads is not
       * how big it is but how much it FLARES: the pad is 4.0 times the width of
       * the fetlock directly above it, where a bear's plate is 1.2 times its own
       * column and a wolf's ball 1.5 times its own. A camel's foot looks stuck
       * on, and that is correct. */
      paw: { r: [0.170, 0.055, 0.180], p: [0, -0.745, -0.030] },
      pawGap: 0.016,
      /* TWO toenails, not four claws. @see the claw loop in `_build`. */
      clawCount: 2,
    },
    colours: {
      coat: [0xc2a276, 0xa8875c, 0xd6bd92, 0x8e7148],
      belly: 0xdcc9a6,
      dark: 0x241d16,
      /* Horn, not bone: a camel's toenails are dark against a pale coat, which
       * is the opposite of the bear's pale claws against a dark one. */
      claw: 0x6b5b45,
    },
    /* More repeats ALONG than the predators get, fewer around: a camel's coat
     * lies in long vertical hanks off the neck and shoulder rather than in the
     * short back-swept grain of a wolf's. */
    fur: 'hide.fur:4,10',
  },
};

/**
 * ── THE HULL: a lofted cross-section, for a body whose section is not an
 *    ellipse ─────────────────────────────────────────────────────────────
 *
 * `Organic.sweep` sweeps an ELLIPSE, and an ellipse is the right description of
 * a wolf's barrel, a leg, a neck and a tail. It is the wrong description of a
 * dromedary, for three reasons that all bite at once:
 *
 *   - the hump. An ellipse cannot rise out of a back; the only way to get a
 *     hump out of `sweep` is to stick a separate ellipsoid on top, and a sphere
 *     resting on a tube reads as a sphere resting on a tube from any distance
 *     at which the intersection is visible at all.
 *   - the keel. A camel's chest hangs BELOW the shoulder line and comes to a
 *     rounded edge, not to the bottom of a circle.
 *   - the slab sides. A camel is flat-sided between the shoulder and the flank.
 *
 * So the camel's body is one lofted surface whose section is a piecewise
 * superellipse, described by six numbers rather than two:
 *
 *      x = hw · sign(cos a) · |cos a|^ex
 *      y = y  + (top − y) · |sin a|^et      for the upper half
 *      y = y  − (y − bot) · |sin a|^eb      for the lower half
 *
 *   `hw`  half-width at the waist, `y` the height of that waist
 *   `top` `bot`  absolute heights of the topline and the underline
 *   `ex`  side fullness. 1 is an ellipse; below 1 the flank stays out at full
 *         width for longer and the animal goes slab-sided.
 *   `et`  `eb`  how POINTED the top and the bottom are. 1 is an ellipse; above
 *         1 the surface stays low across the width and then climbs, which is a
 *         ridge - and a ridge that rises and falls along the length of the back
 *         IS the hump, made of the same skin as the back it grows out of.
 *
 * At `ex = et = eb = 1` and `top − y === y − bot` this draws exactly the ellipse
 * `sweep` would have drawn, which is the check that this is a generalisation of
 * the ellipse and not a different thing standing next to it.
 *
 * Rings stand perpendicular to Z rather than to the path. A quadruped's spine
 * runs along Z and rises 0.2 m over 2 m of length, so the difference is under
 * six degrees, and standing the rings up is what lets the crest of the hump be
 * one ridge line instead of a seam that wanders across the back.
 *
 * @param {Array<{z:number,y:number,hw:number,top:number,bot:number,ex:number,
 *   et:number,eb:number}>} stations at least two, ordered along +Z
 * @param {number} [radial] vertices around the section. Must be a multiple of
 *   four so that a = 90 deg lands ON a vertex and the crest is a ridge rather
 *   than a chamfer between the two rings of vertices either side of it.
 * @returns {THREE.BufferGeometry} non-indexed and flat-shaded, like every other
 *   surface in this file
 */
function loft(stations, radial = 24) {
  const n = stations.length;
  if (n < 2) throw new Error('loft needs at least two stations');
  if (radial % 4 !== 0) throw new Error('loft radial must be a multiple of four');

  const rings = [];
  for (let i = 0; i < n; i++) {
    const st = stations[i];
    const ring = [];
    for (let k = 0; k < radial; k++) {
      const a = (k / radial) * TAU;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const x = st.hw * Math.sign(c) * Math.abs(c) ** st.ex;
      const y = s >= 0
        ? st.y + (st.top - st.y) * Math.abs(s) ** st.et
        : st.y - (st.y - st.bot) * Math.abs(s) ** st.eb;
      ring.push(new THREE.Vector3(x, y, st.z));
    }
    rings.push(ring);
  }

  const pos = [];
  const uv = [];
  const push = (v, u, w) => { pos.push(v.x, v.y, v.z); uv.push(u, w); };
  for (let i = 0; i < n - 1; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    const v0 = i / (n - 1);
    const v1 = (i + 1) / (n - 1);
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial;
      const u0 = k / radial;
      const u1 = (k + 1) / radial;
      push(a[k], u0, v0); push(b[k2], u1, v1); push(b[k], u0, v1);
      push(a[k], u0, v0); push(a[k2], u1, v0); push(b[k2], u1, v1);
    }
  }
  /* Both ends collapse to their own waist centre. The end stations are drawn
   * small on purpose: a fan across a full-width section is a flat disc, and a
   * flat disc across the front of the chest is exactly what made the old body
   * look cut off from three-quarters front. */
  for (const [i, dir] of [[0, -1], [n - 1, 1]]) {
    const st = stations[i];
    const centre = new THREE.Vector3(0, st.y, st.z);
    const r = rings[i];
    const v = i / (n - 1);
    for (let k = 0; k < radial; k++) {
      const k2 = (k + 1) % radial;
      const u0 = k / radial;
      const u1 = (k + 1) / radial;
      if (dir < 0) { push(centre, 0.5, v); push(r[k], u0, v); push(r[k2], u1, v); }
      else { push(centre, 0.5, v); push(r[k2], u1, v); push(r[k], u0, v); }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  return geo;
}

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

  /**
   * The authored geometries bound to one `node:slot` pair, or an empty array.
   *
   * Returned by reference and NEVER disposed here: the cache in `BeastAssets`
   * owns them and every animal in a pack merges the same buffers. `merge()`
   * calls `toNonIndexed()` on an indexed input and disposes only that copy,
   * which is why the loader refuses a non-indexed part.
   *
   * @param {string} pair e.g. `'head:dark'`
   */
  _welds(pair) {
    return this._authored?.get(pair) ?? [];
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

    /**
     * Authored hero features, or an empty list.
     *
     * Read ONCE per animal and bucketed by the `node:slot` pair the manifest
     * names, so the merge lists below can splice their share in without each
     * knowing the loader exists. Empty is the normal case in `node --test` and
     * the correct case for a player whose download failed: every merge below
     * is `[...procedural, ...authored]`, and with nothing authored that is
     * byte-for-byte the animal that shipped before.
     *
     * @see src/worlds/medieval/BeastAssets.js for why they are merged rather
     * than parented, and why they are never cloned.
     */
    this._authored = new Map();
    for (const part of beastParts(this.species) ?? []) {
      const pair = `${part.node}:${part.slot}`;
      if (!this._authored.has(pair)) this._authored.set(pair, []);
      this._authored.get(pair).push(part.geometry);
    }

    /* ---- body: one merged, continuous mass ----
     *
     * Two descriptions of the same thing, and a profile carries exactly one of
     * them. `barrel` is an ellipse swept along a path and is what a wolf and a
     * bear are; `hull` is a lofted superellipse and is what a camel is, because
     * a hump has to be part of the back rather than an ellipsoid resting on it.
     * The `barrel` arm below is untouched to the character, so the two
     * predators come out of this line bit-for-bit as they always did. */
    const bodyParts = [P.hull ? loft(P.hull, 24) : sweep(P.barrel, 18)];
    for (const m of P.masses) bodyParts.push(massGeo(m, 1));
    if (P.hump) bodyParts.push(massGeo(P.hump, 1, 14));
    // The dorsal crest, if this species has one authored. Appended rather than
    // inserted, so with nothing authored the merge order - and therefore the
    // resulting buffer - is exactly what it was.
    bodyParts.push(...this._welds('body:coat'));
    const bodyMesh = this._add(this.tilt, merge(bodyParts), coat);
    /** The manager's LOD and the combat flash both look for this. */
    this.mesh = bodyMesh;
    /** No separate hair mesh on a quadruped; the field exists for the callers. */
    this.hairMesh = null;

    /* ---- neck + head ---- */
    this.neck = new THREE.Group();
    this.neck.position.set(...P.neck.at);
    this.tilt.add(this.neck);
    /* The ruff, if this species has one authored - and the un-merged sweep if
     * it does not.
     *
     * The branch is not a micro-optimisation, it is a correctness gate that
     * `camel.test.mjs` caught. Every other weld site here was ALREADY a
     * `merge()`, so appending an empty list to it changes nothing; the neck
     * was a bare `sweep`, and `merge()` calls `toNonIndexed()` on its inputs -
     * so wrapping it unconditionally expanded an indexed neck into a
     * non-indexed one on every animal in the game, including the ones with no
     * authored parts at all. `bodyDigest` pins the wolf's and the bear's
     * vertices and said so immediately. A player whose download failed must
     * get the animal that shipped before, to the last bit. */
    const neckWelds = this._welds('neck:coat');
    const neckGeo = sweep(P.neck.sections, 16, { capStart: false });
    this._add(this.neck, neckWelds.length ? merge([neckGeo, ...neckWelds]) : neckGeo, coat);

    this.head = new THREE.Group();
    this.head.position.set(...P.head.at);
    this.neck.add(this.head);
    this._add(
      this.head,
      merge([
        sweep(P.head.sections, 16),
        massGeo(P.head.cheeks, -1, 10),
        massGeo(P.head.cheeks, 1, 10),
        ...this._welds('head:coat'),
      ]),
      coat
    );

    /* Eyes: two dark beads. Six triangles' worth of geometry that does more
     * for "this thing is looking at me" than the whole skull does.
     *
     * Placed off `cheeks` by default, which is where the wolf's and the bear's
     * have always come from and is exactly reproduced below. A profile may
     * override with `head.eye` when that expression cannot reach: a camel's
     * skull is a third of a bear's width and its eyes stand proud of it, so
     * derived-from-the-cheeks would bury them inside the head. */
    const eye = P.head.eye ?? {
      x: P.head.cheeks.p[0] * 0.62,
      y: P.head.cheeks.p[1] + 0.038,
      z: P.head.sections[2].z + 0.02,
      r: 0.017,
      rz: 0.014,
    };
    const eyeRz = eye.rz ?? eye.r;
    /* The authored nose pad rides in here, and that is a decision rather than
     * a convenience: `dark` is the head's only non-coat surface, so a nose
     * merged into the eyes arrives already the right colour and costs no mesh.
     * It inherits `detail: true` with them, which is correct - a 3 cm pad and
     * a 1.7 cm eye bead stop being resolvable at the same distance. */
    const eyeGeo = merge([
      blob(eye.r, eye.r, eyeRz, -eye.x, eye.y, eye.z, 8),
      blob(eye.r, eye.r, eyeRz, eye.x, eye.y, eye.z, 8),
      ...this._welds('head:dark'),
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
    /* COUNTERSHADING, part one. See the note on `belly` above: this mesh and
     * the four lower legs already existed and already cost a draw call each,
     * so moving them onto the `belly` surface is free and is the difference
     * between an animal and a single-value lozenge. The lower jaw is the right
     * place for it because every mammal's is pale (or, on a bear, DARK -
     * `bear.colours.belly` is under its coat range, and the same swap reads
     * correctly for the opposite reason). */
    this._add(this.jaw, sweep(J.sections, 12, { capStart: false }), belly);

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
      /* COUNTERSHADING, part two - the cannon and the paw, on `belly`.
       *
       * This is where the wasted clone becomes the point. Every profile in
       * this file declares a `belly` colour, a material was cloned for it on
       * every animal built since the file was written, and it was assigned to
       * nothing: a wolf whose table says its underside is 0x9a9184 shipped one
       * flat 0x6b6259 from nose to tail. Photographed at 5.5 m the pack read
       * as four identical single-value lozenges.
       *
       * Below the knee is the right half of the animal to spend it on. It is
       * what a viewer sees against the ground - the highest-contrast edge on a
       * quadruped - and unlike a belly panel it needs no new mesh, because the
       * lower leg is already its own draw call. Countershading for nothing. */
      this._add(lower, merge([
        sweep(L.lower.map((k) => ({ y: k.y, z: 0, rx: k.rx, ry: k.ry })), 12, { capStart: false }),
        blob(L.paw.r[0], L.paw.r[1], L.paw.r[2], L.paw.p[0], L.paw.p[1], L.paw.p[2], 10),
      ]), belly);

      /* Claws: short spikes off the front of the paw.
       *
       * Four by default, which is what a wolf and a bear have. A profile may
       * ask for another number - the camel has TWO toenails - and the spacing
       * widens by the same factor so however many there are they still span the
       * same fraction of the foot. At `n === 4` both expressions are the ones
       * that were here before: `(n - 1) / 2` is exactly 1.5 and `4 / n` is
       * exactly 1, multiplying an IEEE754 double by 1 is the identity, and the
       * multiplication ORDER below is unchanged - so the wolf's and the bear's
       * claws come out bit-for-bit unchanged. */
      const claws = [];
      const clawN = L.clawCount ?? 4;
      const clawMid = (clawN - 1) / 2;
      const clawSpread = 4 / clawN;
      for (let i = 0; i < clawN; i++) {
        const cx = (i - clawMid) * L.paw.r[0] * 0.52 * clawSpread;
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
    const spine = P.hull ?? P.barrel;
    this.bodyLength = (spine[spine.length - 1].z - muzzleZ) * this.heightScale;

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
