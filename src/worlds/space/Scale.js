/**
 * THE SCALE SCHEME - how 800 kilometres of space fits inside a 2,000 metre
 * far plane without a second camera pass.
 *
 * ===========================================================================
 *  THE PROBLEM, STATED
 * ===========================================================================
 *
 * `CONFIG.render.far` is 2000 and `CONFIG.render.near` is 0.1. Those belong to
 * the shared camera every world uses; a space world cannot widen them without
 * paying for the depth precision in Medieval's shadow terminator, and it
 * cannot add a second render pass without owning Engine.js. So the volume has
 * to be DRAWN inside [0.1, 2000] while being SIMULATED at true size.
 *
 * A planet 62 km away is not going to be moved into that range by shrinking
 * the world: shrink it and the ship crosses it in four seconds. The distances
 * are the point - "fly out and down for a minute and the orange spark becomes
 * a world" is the experience being bought.
 *
 * ===========================================================================
 *  THE ANSWER: ANGULAR-EXACT PROXY PLACEMENT
 * ===========================================================================
 *
 * Two frames, and only one of them is real.
 *
 *   TRUE FRAME    Where the simulation lives. Ship position, body positions,
 *                 collision, HUD ranges, the descent handoff test. Metres.
 *                 Nothing here ever knows the proxy exists.
 *
 *   RENDER FRAME  What the camera sees. A body at true distance D with true
 *                 radius R is drawn along the SAME direction from the camera,
 *                 at proxy distance d, scaled to radius r = R*d/D.
 *
 * The scale factor is the whole trick. A sphere of radius r at distance d
 * subtends angular radius asin(r/d). Substituting r = R*d/D:
 *
 *        asin(r/d) = asin( (R*d/D) / d ) = asin(R/D)
 *
 * - the proxy's silhouette is IDENTICAL, to the pixel, at every d. Not
 * approximately, not "close enough at distance": identical. And a uniform
 * scale does not change a sphere's normals, so the lit hemisphere, the
 * terminator and the specular are identical too. The only thing the proxy
 * loses is intra-body parallax between the two eyes of a stereo pair, and this
 * game is monocular.
 *
 * So the proxy is free. What we spend it on is the depth buffer: d can be
 * chosen to keep every drawn body inside the far plane, in an order that
 * matches true distance.
 *
 * -- The map ----------------------------------------------------------------
 *
 *   D <= NEAR_FIELD    d = D            identity. Nothing is moved.
 *   D >  NEAR_FIELD    d = NEAR_FIELD + SPAN * ln(D/NEAR_FIELD)/LOG_SPAN
 *
 * Logarithmic, because the interesting quantity is ratio-of-distance, not
 * difference: halving the range to a planet should feel the same whether you
 * started at 200 km or at 4 km, and log is the map that says so.
 *
 * Continuous at the seam: at D = NEAR_FIELD the log term is zero, so d = D and
 * the scale factor is exactly 1. A body drifting across 1,400 m does not pop -
 * it cannot, because its angular size was already exact on both sides and the
 * position is continuous through the join.
 *
 * -- The far-limb cap -------------------------------------------------------
 *
 * A sphere is not a point: its far limb sits at d*(1 + R/D). Close to a large
 * body that overshoots the far plane and the planet gets its back sliced off.
 * `proxyPlacement` therefore also caps d at FAR_SAFE/(1 + R/D). The cap only
 * ever pulls a body NEARER, which never clips anything and never changes its
 * angular size - it just costs depth-buffer separation from bodies behind it.
 *
 * That cap is also the one thing that can reorder two bodies (a big far planet
 * capped hard while a small near one is not). `Backdrop.js` handles it by not
 * relying on the depth TEST between backdrop bodies at all - see the painter
 * ordering note there. The cap is why that note exists.
 *
 * -- Why not just move the far plane out ------------------------------------
 *
 * Worked out on paper: far = 1e6 with near = 0.1 leaves roughly 7 bits of
 * usable depth at a hundred metres, and every panel on the dock z-fights.
 * Logarithmic depth needs a shader edit on every material in the game,
 * including the ones in the other seven worlds. The proxy costs one multiply
 * per body per frame and touches nothing outside this folder.
 *
 * Nothing in this file imports three. It is pure arithmetic so it can be
 * tested without a GPU, and it is - scripts/tests/space-scale.test.mjs.
 */

/**
 * True distance, in metres, inside which nothing is moved at all.
 *
 * 1400 and not 1900: everything the player interacts with - their own ship, an
 * incoming fighter, the rock they are about to hit - must be drawn at its true
 * position, because that is the position collision and aim use. 1400 m of
 * untouched space around the ship is a comfortable margin over weapon range,
 * and it leaves 480 m of far plane for the whole rest of the universe.
 */
export const NEAR_FIELD = 1400;

/** Proxy distance a body at DEPTH_HORIZON or beyond is drawn at. */
export const PROXY_MAX = 1880;

/**
 * The true distance that maps to PROXY_MAX. Anything further is drawn at
 * PROXY_MAX - still angular-exact, only its depth ordering saturates. 800 km
 * comfortably contains the whole body layout; the star at 640 km is the
 * furthest thing that exists.
 */
export const DEPTH_HORIZON = 800000;

/**
 * No drawn surface may sit beyond this. 1900, not 2000: the far plane is a
 * hard clip and a body whose limb lands exactly on it flickers as the ship
 * translates. 100 m of headroom at a proxy distance of 1900 is 5%.
 */
export const FAR_SAFE = 1900;

const SPAN = PROXY_MAX - NEAR_FIELD;
const LOG_SPAN = Math.log(DEPTH_HORIZON / NEAR_FIELD);

/**
 * True distance -> proxy distance. Monotone increasing, identity below
 * NEAR_FIELD, saturating at PROXY_MAX.
 *
 * @param {number} D true distance from the camera, metres. Finite and > 0.
 * @returns {number} proxy distance, metres, in (0, PROXY_MAX].
 */
export function proxyDistance(D) {
  if (!Number.isFinite(D) || D <= 0) {
    /* House rule, learned the expensive way one folder over: a non-finite here
     * becomes a NaN position, a NaN vertex, and then - through bloom - a black
     * frame with no clue in it. Throw where the mistake is. */
    throw new Error(`[space/Scale] proxyDistance needs a finite positive distance, got ${D}`);
  }
  if (D <= NEAR_FIELD) return D;
  const t = Math.log(D / NEAR_FIELD) / LOG_SPAN;
  return NEAR_FIELD + SPAN * (t < 1 ? t : 1);
}

/**
 * Where and how big to draw a sphere of true radius R whose centre is at true
 * distance D from the camera.
 *
 * `scale` is what you multiply the true radius by AND what you multiply any
 * true offset-from-centre by - a ring, a moon, a docking light on a hull all
 * stay in register if they are scaled about the body centre by the same number.
 *
 * @param {number} D true centre distance, metres
 * @param {number} R true radius, metres (0 for a point-like object)
 * @param {{d:number, scale:number}} out reused result; allocates nothing
 * @returns {{d:number, scale:number}} out
 */
export function proxyPlacement(D, R, out) {
  if (!Number.isFinite(R) || R < 0) {
    throw new Error(`[space/Scale] proxyPlacement needs a finite radius >= 0, got ${R}`);
  }
  let d = proxyDistance(D);
  const q = R / D;
  // Keep the far limb inside the far plane. Only ever pulls the body nearer.
  const cap = FAR_SAFE / (1 + q);
  if (d > cap) d = cap;
  out.d = d;
  out.scale = d / D;
  return out;
}

/**
 * Angular RADIUS in radians of a sphere of radius R seen from distance D.
 * Double it for the angular diameter people quote.
 *
 * Saturates at PI/2 once the camera is inside the sphere rather than returning
 * NaN out of `asin`: the descent handoff is allowed to run one frame late, and
 * a NaN there would end the frame.
 */
export function angularRadius(R, D) {
  if (!Number.isFinite(R) || !Number.isFinite(D) || D <= 0) return Math.PI / 2;
  const q = R / D;
  return q >= 1 ? Math.PI / 2 : Math.asin(q);
}

/**
 * Fraction of the VERTICAL field of view a body of radius R fills at distance
 * D. 1.0 means "top of the screen to the bottom". This is the number to reason
 * about when placing a body: below 0.01 it is a star, 0.05 is a disc you can
 * see is a disc, above 0.9 it is a world filling the view.
 *
 * @param {number} fovDeg vertical field of view in degrees (CONFIG.render.fov)
 */
export function screenFraction(R, D, fovDeg) {
  return (2 * angularRadius(R, D)) / ((fovDeg * Math.PI) / 180);
}
