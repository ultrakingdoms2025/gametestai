/**
 * THE PLANET DESCRIPTOR: the whole schema, and the validator that enforces it.
 *
 * A planet is DATA. `PlanetWorld` is the one world class that renders any of
 * them, and everything that makes Cinder a volcano rather than an ice moon
 * lives in the record `definePlanet()` returns here. The test of that boundary
 * is blunt and it is the reason this module exists: a tenth planet must cost a
 * tenth descriptor and no new world class, no new height function and no `if
 * (planet.id === ...)` anywhere in the renderer.
 *
 * Nothing in this file may import `three`. Two of its consumers - the height
 * field and the generation worker - run where `three` does not exist, and the
 * `terrain` block below is handed to `postMessage` verbatim. That is also why
 * a descriptor may contain no functions: a closure does not survive the
 * structured clone, and the day one did the worker would silently fall back to
 * flat ground.
 *
 * ==========================================================================
 *  THE SCHEMA
 * ==========================================================================
 *
 * id            string     unique key. The world registers as `planet:<id>`.
 * name          string     display name, shown in the HUD and loading screen.
 * blurb         string     one line, for the loading screen and the log.
 *
 * half          number     playfield half-extent, metres. The map is 2*half square.
 * seg           number     terrain grid segments per side. The mesh AND the
 *                          collision heightfield are both this grid - see
 *                          `PlanetWorld._buildTerrain` on why they must be.
 *
 * gravity       number     m/s^2 at the surface. It reaches BOTH the ship
 *                          (`Piloting._env`) and the player on foot
 *                          (`Player.setWorldGravity`, via `worldGravity()` in
 *                          `WorldRules.js`, which is the single reader).
 *
 *                          Phase 1 said here that it did NOT reach the player,
 *                          "and saying so is better than a number nobody
 *                          applied" - which was the honest call while one planet
 *                          existed. With ten spanning 1.62 to 10.10 it was a
 *                          whole dimension of variety left unused, so it landed.
 *
 *                          It is applied as a RATIO, not as m/s^2:
 *                          `g_player = CONFIG.player.gravity * (gravity / 9.81)`.
 *                          The default is -22, i.e. 2.24 real g, and every
 *                          hand-built world is authored against it - feed raw
 *                          m/s^2 in and Verdigris, the HEAVIEST body in the
 *                          system, would weigh less than half a shopping
 *                          concourse. A planet publishing 9.81 is byte-identical
 *                          to one publishing nothing.
 *
 *                          The jump is re-solved rather than left alone: apex
 *                          scales as r^-1/3 and hang time as r^-2/3, so airtime
 *                          grows as the SQUARE of jump height. Leaving the
 *                          impulse alone gives Tessera 6.1x the default apex (a
 *                          catapult over roofless geometry); preserving apex
 *                          exactly makes the one famous fact about low gravity
 *                          untrue. Measured: Tessera 1.67 m apex / 1.88 s hang
 *                          against a default 0.88 / 0.53.
 *
 *                          `airAcceleration` scales as r^2/3 so the total mid-air
 *                          delta-v one jump buys is INVARIANT. Without that,
 *                          3.5x the airtime is 3.5x the steering - a floaty jump
 *                          would be an easier one, which is backwards. It should
 *                          be a COMMITTED one.
 *
 * ---- terrain -------------------------------------------------------------
 * terrain       object     verbatim params for `HEIGHT_FIELDS.planet`. Plain
 *                          data only. See `terrain/PlanetHeight.js` for the
 *                          landform vocabulary; the fields are
 *                          { seed, half, baseY, swell, ripple, grain, rim,
 *                            landforms: [...] }.
 *                          `half` is filled in from the descriptor's own `half`
 *                          if the block omits it, so the two cannot disagree.
 *
 * ---- look ----------------------------------------------------------------
 * palette       object     how the ground is coloured.
 *   material      string   material-library key for the terrain surface.
 *                          IT MUST BE A HUE-FREE KEY. `_buildTerrain` writes
 *                          `bands` as vertex colours and vertex colours
 *                          MULTIPLY into the material's albedo map, so any hue
 *                          baked into that map is a filter over this entire
 *                          table. `dirt.ground` measures linear R:G:B =
 *                          1.79 : 1 : 0.49 and rendered the ice world as brown
 *                          moorland while `planet-atmosphere.test.mjs` was
 *                          happily measuring 176 degrees of hue in its bands -
 *                          a numeric gate on THIS FILE cannot see what this
 *                          file gets multiplied by. Use `rock.neutral` (the
 *                          general case) or `ice.sheet`; `dirt.ground` is
 *                          grandfathered on Cinder alone and deliberately.
 *   tile          number   metres one texture tile covers on the ground.
 *   bands         array    [{ upTo, color }] absolute-height colour bands,
 *                          interpolated. The last band's `upTo` is ignored.
 *   slope         object   { fromDeg, toDeg, color } - exposed rock on anything
 *                          steeper than `fromDeg`, fully by `toDeg`.
 *   mottle        object   { scale, amount, color } - large-scale colour drift,
 *                          which is what stops a banded terrain reading as a
 *                          contour map.
 *   patch         array    [{ region, color, strength?, feather?, grain?,
 *                          grainScale? }] - COLOUR SOMEWHERE IN PARTICULAR.
 *
 *                          The three terms above are all GLOBAL functions of
 *                          the ground: height, steepness and one isotropic
 *                          noise. Between them they cannot say "this feature
 *                          is a different colour", and three planet authors hit
 *                          the same wall independently:
 *                            - Tessera's ejecta rays are an ALBEDO streak with
 *                              essentially no relief, so they were props and
 *                              nothing else;
 *                            - Lathe's young crater could not have a bright
 *                              floor without giving one to every contour at
 *                              that height on the map;
 *                            - Carnelian's gorge terrace and its Dust Table sit
 *                              four metres apart in height and share a band.
 *
 *                          A patch is a REGION - the same placement language
 *                          the props and the minerals use, listed below - and a
 *                          colour to lerp toward inside it. Reusing the region
 *                          record is the whole point: a ray and the chips lying
 *                          along it are one polyline and one width, declared
 *                          once, so they cannot drift apart. The `yMin`/`yMax`/
 *                          `slopeMaxDeg`/`slopeMinDeg` filters all apply, which
 *                          is what lets a crater floor be addressed as "inside
 *                          this disc AND below this height" - the thing a
 *                          height band on its own cannot say.
 *
 *                            region      any region record (see REGIONS below)
 *                            color       what to lerp toward
 *                            strength    0..1, how far. Default 1.
 *                            feather     metres the edge fades over, measured
 *                                        INWARD from the region boundary.
 *                                        Default 0 - a hard stencil, which is
 *                                        almost never what ground looks like.
 *                            grain       0..1, how much the SAME fbm the mottle
 *                                        uses breaks the patch up, so it reads
 *                                        as scattered material rather than as
 *                                        paint. Default 0.
 *                            grainScale  metres per noise cell. Default 24.
 *
 *                          Patches are applied in order, AFTER the mottle, and
 *                          they accumulate: two overlapping records are how a
 *                          ray is made brighter near the crater it came out of
 *                          than at its tip.
 *
 *                          `clearOfLiquid` and `clearOfPads` are NOT honoured -
 *                          they are scatter-rejection rules, and refusing to
 *                          colour ground near a pad would draw a ring round
 *                          every landing site.
 *
 * sky           object     the air and the light.
 *   kind          string   'daylight' | 'alpine' | 'space' - the dome shader.
 *   params        object   overrides passed straight to `createSky`.
 *   background    number   clear colour behind everything.
 *   fog           object   { color, near, far }.
 *   ambient       object   { color, intensity }.
 *   sun           object   { color, intensity, direction: [x, y, z] }.
 *   exposure      number   tone-map exposure.
 *   grade         any      `PostFX` grade preset name or override object. A
 *                          planet is not in `GRADE_PRESETS` (that table is keyed
 *                          on world id), so naming one here is how a planet
 *                          borrows a look that was already calibrated.
 *   bloom         object   { strength, radius, threshold } or null.
 *
 * ---- liquid --------------------------------------------------------------
 * liquid        object|null  lava, water, methane - one substance per planet.
 *   name          string   what it is called in the log and the HUD.
 *   bodies        array    [{ shape:'disc', x, z, r, y }] or
 *                          [{ shape:'ribbon', pts, width, y0, y1 }]. Each is a
 *                          drawn surface at an authored height. They are NOT
 *                          derived from the terrain: a lake whose level came
 *                          out of a `min()` over the basin would move whenever
 *                          the noise did.
 *   color         number   deep colour.
 *   hot           number   emissive colour of the incandescent cracks.
 *   crust         number   the chilled skin between them.
 *   emissive      number   emissive strength.
 *   flow          number   metres/second the crust drifts.
 *   glowLight     object|null { color, intensity, distance } - ONE point light
 *                          per body, at most. `RIG_BUDGET.point` is 12 across
 *                          the whole game and every one is compiled into every
 *                          shader.
 *   lethal        bool     Phase 1 keeps this false everywhere; it is here so
 *                          the day it turns true nothing has to be re-plumbed.
 *
 * ---- what is on the ground ----------------------------------------------
 * props         array      scatter fields. Each:
 *   id            string   unique within the planet.
 *   kind          string   one of `PROP_KINDS` - the instanced prop families
 *                          `PlanetProps` knows how to build, listed below. A
 *                          planet that needs a new SHAPE adds a kind there; a
 *                          planet that needs a new PLACE only adds a record
 *                          here.
 *   region        object   see below.
 *   count         number   how many to try to place.
 *   size          object   kind-specific dimensions, all metres. The per-kind
 *                          records are below. NOT validated here: the two
 *                          styles below ('rMin/rMax' and '[min, max]') are
 *                          read, range-checked and REFUSED by
 *                          `PlanetProps.buildPropField`, which is also the only
 *                          module that knows what each field means. A second
 *                          copy of those rules here would be a second copy that
 *                          goes stale.
 *   tint          array    colours to pick between.
 *   trunkTint     array    `growth` only - the second palette, for the trunk.
 *   glow          number   emissive colour for the whole field, 0/absent for
 *                          none. Per FIELD and not per instance: an instance
 *                          colour multiplies the diffuse and never the
 *                          emissive, so a glowing crystal field is one material
 *                          off the shared rock - still one mesh, still one draw
 *                          call. `glowStrength` (default 1.4) scales it.
 *   collide       bool     whether each instance gets a collider. WHAT that
 *                          collider is depends on the kind - a spire gets its
 *                          foot, growth gets its trunk, a slab gets a rotated
 *                          step. See the `PlanetProps` header.
 *   spacing       number   minimum centre-to-centre distance, metres.
 *
 *   THE FAMILIES, and the `size` record each one reads:
 *
 *   columns    hexagonal basalt prisms, tall and near-plumb.
 *                { rMin, rMax, hMin, hMax, sides? }
 *   shards     four-sided obsidian spikes, leaning hard.
 *                { wMin, wMax, hMin, hMax }
 *   boulders   faceted ejecta blocks, half-buried, tumbled.
 *                { rMin, rMax }
 *   vents      flared open fumarole mouths. A `vents` field also gets a plume
 *              field driven off the same points.
 *                { rMin, rMax, plumeMin?, plumeMax? }
 *   spires     tall, sharply tapering faceted pinnacles - ice on a glacier,
 *              crystal on a shattered plate. Concave profile, near-zero tip,
 *              random lean off vertical so a field looks grown.
 *                { h: [min, max], base: [min, max], lean?, facets? }
 *                lean   radians off plumb, +/-, default 0.16, capped 0.6
 *                facets sides, default 5, clamped to 4..7
 *   growth     biotic growth for a jungle: a slim tapered trunk under a
 *              squashed, lumped, drooping canopy mass. Takes TWO palettes -
 *              `tint` is the canopy and `trunkTint` the trunk.
 *                { trunk: [min, max], h: [min, max], canopy: [min, max], droop? }
 *                trunk  trunk radius; the canopy is what is sampled per
 *                       instance and the trunk follows it in proportion, so
 *                       this sets the MEAN
 *                canopy canopy radius, sampled twice per instance so no crown
 *                       is round
 *                droop  0..1, how far the underside sags and flares, default
 *                       0.35
 *   slabs      tilted flat plates - shattered ice, upended tectonic sheets,
 *              cracked pavement. Every instance is tilted, yawed and a
 *              different thickness, or a field of them reads as a floor.
 *                { w: [min, max], d: [min, max], t: [min, max], tilt? }
 *                tilt   radians off horizontal, +/-, default 0.5, capped 1.35
 *
 *   Every `[min, max]` pair must be finite and positive with max >= min.
 *   min === max is allowed and means "this dimension does not vary"; anything
 *   that could produce a zero, a negative or a NaN throws at build time,
 *   because a zero scale is a singular instance matrix and decomposing one
 *   divides by the scale.
 *
 * ==========================================================================
 *  MINERALS - the reason to fly to THIS planet rather than any planet
 * ==========================================================================
 *
 * A mineral record is a deposit AND an economy row AND a promise about where
 * on the map you have to go. The fields below exist so that all three are one
 * declaration and cannot drift apart, and so that "rare" is a measured
 * property of the table rather than a word in a display name.
 *
 * minerals      array      Each:
 *   id            string   unique within the planet. NOT a private label: it
 *                          is published as `node.type` on every mineral node,
 *                          it is the key the ship's hold groups cargo by
 *                          (`Piloting.stow`), and it is what a `collect`
 *                          quest step names.
 *   item          string   the `ITEMS` id this ore is once it is out of the
 *                          ground - the bag row, the vendor row, the price.
 *                          NOT resolved here: this module may not import a
 *                          game system (see the header). It is resolved, for
 *                          every planet in the registry at once, by
 *                          `scripts/tests/planet-minerals.test.mjs`, which is
 *                          also where `unitValue` is held to `ITEMS[item].value`.
 *   name          string   display name, shown on the mining prompt.
 *   rarity        string   one of `MINERAL_RARITY`, which is an ORDERED
 *                          LADDER: common, uncommon, rare, exotic. Four rules
 *                          below make that word mean something, and every one
 *                          of them throws:
 *                            - the tiers used must run CONTIGUOUSLY up from
 *                              `common`, so a planet cannot be all-exotic;
 *                            - `unitValue` must ascend strictly BETWEEN tiers
 *                              (the dearest common ore is cheaper than the
 *                              cheapest uncommon one);
 *                            - `count` must not ascend between tiers (a rarer
 *                              thing is not more numerous);
 *                            - the RAREST tier on the planet may not sit in
 *                              `terrain: 'plain'` and may not use a `field`
 *                              region. A rare element scattered over the whole
 *                              map, underfoot at the pad, is a common element
 *                              with an expensive name.
 *   terrain       string   one of `MINERAL_TERRAINS` - the landform FAMILY the
 *                          seam belongs to, in vocabulary a second planet can
 *                          use unchanged. It is what makes "go and mine rare
 *                          elements" resolve to a place: the HUD, the log and
 *                          a future survey chart all read this, and the reach
 *                          probe groups its report by it.
 *   place         string   the feature's own name on THIS planet ("The Outlet
 *                          Gorge"). Free text, because it is a proper noun.
 *   color         number   the seam's own colour.
 *   glow          number   emissive colour, 0 for none.
 *   unitValue     number   credits ONE CUBIC METRE OF HOLD of this ore is
 *                          worth. Value is quoted per volume and not per node
 *                          because volume is what the player is actually
 *                          short of: a stock Kestrel has 10 m3 and a Dray 40,
 *                          so "which of these do I fill the hold with" is the
 *                          decision the number has to serve.
 *   spread        number   0..0.5. Per-node value varies +/- this fraction, so
 *                          two seams of the same ore are not the same pickup.
 *   size          number   node radius in metres, and THEREFORE the hold
 *                          volume: `Piloting.stow` charges
 *                          `max(1, round(size * 1.6))` cubic metres and this
 *                          module computes the value off the same formula (see
 *                          `holdUnitsFor`). One number, so a big dull lump of
 *                          tephra costs three times the hold of a chip of
 *                          iridite and looks like it does.
 *   count         number   nodes to place.
 *   spacing       number   minimum centre-to-centre distance, metres.
 *   region        object   see below.
 *
 *   hold          number   DERIVED. Cubic metres one node occupies.
 *   credits       [lo,hi]  DERIVED, and authoring it is REFUSED. It is
 *                          `unitValue * hold`, plus or minus `spread`. Two
 *                          hand-written numbers next to a price and a volume
 *                          are three copies of one fact, and the third one is
 *                          always the one that goes stale.
 *
 * landing       array      where a ship may set down. Each:
 *   id, name      string
 *   x, z, r       number   centre and usable radius, metres.
 *   primary       bool     exactly one must be true - it is where the player
 *                          arrives on foot when the world is entered directly.
 *   yaw           number   facing on arrival, radians.
 *   Every entry MUST have a matching `pad` landform in `terrain.landforms`, and
 *   `definePlanet` throws if one does not: a landing site that is only an
 *   assertion is how "built but not reachable" gets shipped.
 *
 * ==========================================================================
 *  REGIONS - the placement language
 * ==========================================================================
 *
 * One shape plus optional filters, shared by props and minerals so a vent field
 * and the sulfur that grows on it cannot drift apart.
 *
 *   { shape: 'disc',     x, z, r, rInner? }
 *   { shape: 'annulus',  x, z, r0, r1 }
 *   { shape: 'corridor', pts, width, widthInner? }   band around a polyline;
 *                                            `widthInner` hollows it, which is
 *                                            how a fissure's LIPS are addressed
 *                                            without addressing its floor
 *   { shape: 'rect',     x0, z0, x1, z1 }
 *   { shape: 'field' }                       the whole playfield
 *
 * Filters, all optional and all AND-ed:
 *   yMin, yMax      absolute height window
 *   slopeMaxDeg     reject anything steeper (the usual reason a node is
 *                   unreachable)
 *   slopeMinDeg     reject anything flatter - for things that only grow on a wall
 *   clearOfLiquid   metres of horizontal clearance required from every liquid
 *                   body, so nothing is placed inside a lava lake
 *   clearOfPads     metres of clearance from every landing pad, so nothing is
 *                   placed where a ship comes down
 */

import { LANDFORM_KINDS } from '../terrain/PlanetHeight.js';

const REGION_SHAPES = new Set(['disc', 'annulus', 'corridor', 'rect', 'field']);
const PROP_KINDS = new Set(['columns', 'shards', 'boulders', 'vents', 'spires', 'growth', 'slabs']);
const SKY_KINDS = new Set(['daylight', 'alpine', 'space']);

/**
 * The rarity ladder, commonest first. ORDER IS THE MEANING - `definePlanet`
 * indexes this array to decide which of two minerals must be worth more and
 * which must be scarcer, so re-ordering it re-orders the economy.
 */
export const MINERAL_RARITY = Object.freeze(['common', 'uncommon', 'rare', 'exotic']);

/**
 * The landform families a deposit may belong to.
 *
 * Deliberately generic, and that is the whole point of the field: `fissure`
 * means the rift on Cinder and a pressure crack on an ice moon, so a HUD line,
 * a survey chart or a contract that says "rare elements occur in fissures" is
 * written once for every planet there will ever be. The proper noun goes in
 * `place`.
 */
export const MINERAL_TERRAINS = Object.freeze([
  'plain',       // the flat ground a ship lands on
  'highland',    // a flank, a slope, high open ground
  'shelf',       // a low plateau you can walk straight onto
  'outcrop',     // a mesa, a stack, a tor - high ground with an edge
  'fissure',     // a crack, a rift, a trench
  'crater',      // the inside of a caldera, a pit, an impact bowl
  'channel',     // a gorge, a lava tube, a drainage cut
  'vent_field',  // fumaroles, geysers, degassing ground
  'shore',       // the margin of a liquid body
  'cave',        // enclosed, roofed ground
]);

/**
 * `Piloting.stow`'s own radius-to-volume conversion, and the reason it is
 * spelled out here too.
 *
 * The hold charges `max(1, Math.round((node.size ?? 1) * 1.6))` cubic metres
 * per node (src/ships/Piloting.js, `stow`). A descriptor that priced a node
 * without knowing that would be quoting credits against a volume the ship
 * disagrees with, and the disagreement would only ever show up as "why is the
 * Dray full". This is the second copy of that 1.6 and nothing in either module
 * compares them, so `scripts/tests/planet-minerals.test.mjs` scrapes
 * `Piloting.stow` and fails if they part company - the same arrangement
 * `WORLD_MARKETS.dock` and `WORLD_PRICE_MULTIPLIERS.dock` already live under.
 */
export const HOLD_UNITS_PER_SIZE = 1.6;

/** Cubic metres of hold one node of radius `size` occupies. */
export function holdUnitsFor(size) {
  return Math.max(1, Math.round(size * HOLD_UNITS_PER_SIZE));
}

function need(cond, msg) {
  if (!cond) throw new Error(`[PlanetDescriptor] ${msg}`);
}

function num(v, name) {
  need(typeof v === 'number' && Number.isFinite(v), `${name} must be a finite number, got ${v}`);
  return v;
}

/**
 * Reject anything that will not survive `postMessage`.
 *
 * The failure this prevents is silent and expensive: a function in the terrain
 * block clones to `undefined`, the worker builds a plain, and the world comes
 * back flat with no error anywhere. Checked once at definition time rather than
 * hoped for.
 */
function assertCloneable(value, path) {
  const t = typeof value;
  if (value === null || t === 'number' || t === 'string' || t === 'boolean') {
    if (t === 'number') need(Number.isFinite(value), `${path} is ${value} - non-finite numbers reach the shader as NaN`);
    return;
  }
  need(t === 'object', `${path} is a ${t}; a descriptor may only hold plain data (it crosses postMessage)`);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertCloneable(value[i], `${path}[${i}]`);
    return;
  }
  need(Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    `${path} is a class instance; a descriptor may only hold plain data`);
  for (const k of Object.keys(value)) assertCloneable(value[k], `${path}.${k}`);
}

function validateRegion(r, path) {
  need(r && typeof r === 'object', `${path} is missing`);
  need(REGION_SHAPES.has(r.shape), `${path}.shape "${r.shape}" unknown - one of ${[...REGION_SHAPES].join(', ')}`);
  if (r.shape === 'disc') { num(r.x, `${path}.x`); num(r.z, `${path}.z`); num(r.r, `${path}.r`); }
  if (r.shape === 'annulus') { num(r.x, `${path}.x`); num(r.z, `${path}.z`); num(r.r0, `${path}.r0`); num(r.r1, `${path}.r1`); need(r.r1 > r.r0, `${path}.r1 must exceed r0`); }
  if (r.shape === 'corridor') {
    need(Array.isArray(r.pts) && r.pts.length >= 2, `${path}.pts needs at least two points`);
    num(r.width, `${path}.width`);
  }
  if (r.shape === 'rect') { num(r.x0, `${path}.x0`); num(r.z0, `${path}.z0`); num(r.x1, `${path}.x1`); num(r.z1, `${path}.z1`); }
}

/**
 * Validate, fill defaults, freeze.
 *
 * Throws on anything a later stage would have swallowed. The list of things it
 * refuses is a list of defects this project has actually shipped: content that
 * cannot be reached, geometry with a non-finite dimension, and a "descriptor"
 * that quietly stopped being data.
 *
 * @param {object} d
 * @returns {Readonly<object>}
 */
export function definePlanet(d) {
  need(d && typeof d === 'object', 'a descriptor is required');
  need(typeof d.id === 'string' && /^[a-z][a-z0-9_]*$/.test(d.id), `id "${d.id}" must be lower_snake`);
  need(typeof d.name === 'string' && d.name.length > 0, 'name is required');

  const half = num(d.half, 'half');
  const seg = num(d.seg, 'seg');
  need(Number.isInteger(seg) && seg >= 32, 'seg must be an integer of at least 32');
  num(d.gravity, 'gravity');

  /* ---- terrain -------------------------------------------------------- */
  need(d.terrain && typeof d.terrain === 'object', 'terrain block is required');
  const terrain = { half, ...d.terrain };
  need(terrain.half === half, 'terrain.half disagrees with the descriptor half');
  assertCloneable(terrain, 'terrain');
  const forms = terrain.landforms ?? [];
  need(Array.isArray(forms), 'terrain.landforms must be an array');
  for (let i = 0; i < forms.length; i++) {
    need(LANDFORM_KINDS.includes(forms[i].kind),
      `terrain.landforms[${i}].kind "${forms[i].kind}" unknown - one of ${LANDFORM_KINDS.join(', ')}`);
  }

  /* ---- look ----------------------------------------------------------- */
  const palette = d.palette ?? {};
  need(Array.isArray(palette.bands) && palette.bands.length >= 2, 'palette.bands needs at least two entries');
  for (let i = 1; i < palette.bands.length; i++) {
    need(palette.bands[i].upTo > palette.bands[i - 1].upTo, `palette.bands must ascend by upTo (index ${i})`);
  }
  /* ---- palette.patch -------------------------------------------------- *
   * Defaults are filled in HERE rather than in the renderer, so the frozen
   * descriptor a test reads is the same record `_terrainColors` walks and
   * "what is the strength of this patch" has one answer.                    */
  const patches = [];
  const rawPatches = palette.patch ?? [];
  need(Array.isArray(rawPatches), 'palette.patch must be an array of { region, color, ... }');
  for (let i = 0; i < rawPatches.length; i++) {
    const q = rawPatches[i];
    const at = `palette.patch[${i}]`;
    need(q && typeof q === 'object', `${at} is missing`);
    validateRegion(q.region, `${at}.region`);
    num(q.color, `${at}.color`);
    const strength = q.strength ?? 1;
    num(strength, `${at}.strength`);
    need(strength > 0 && strength <= 1,
      `${at}.strength is ${strength} - a patch that changes nothing is a record nobody can see`);
    const feather = q.feather ?? 0;
    num(feather, `${at}.feather`);
    need(feather >= 0, `${at}.feather must not be negative`);
    const grain = q.grain ?? 0;
    num(grain, `${at}.grain`);
    need(grain >= 0 && grain <= 1, `${at}.grain must be 0..1, got ${grain}`);
    const grainScale = q.grainScale ?? 24;
    num(grainScale, `${at}.grainScale`);
    need(grainScale > 0, `${at}.grainScale must be positive - it divides`);
    patches.push(Object.freeze({
      id: q.id ?? `patch${i}`,
      region: Object.freeze({ ...q.region }),
      color: q.color,
      strength,
      feather,
      grain,
      grainScale,
    }));
  }
  const sky = d.sky ?? {};
  need(SKY_KINDS.has(sky.kind ?? 'daylight'), `sky.kind "${sky.kind}" unknown`);

  /* ---- liquid --------------------------------------------------------- */
  const liquid = d.liquid ?? null;
  if (liquid) {
    need(Array.isArray(liquid.bodies) && liquid.bodies.length > 0, 'liquid.bodies must be a non-empty array');
    for (let i = 0; i < liquid.bodies.length; i++) {
      const b = liquid.bodies[i];
      need(b.shape === 'disc' || b.shape === 'ribbon', `liquid.bodies[${i}].shape must be disc or ribbon`);
      if (b.shape === 'disc') { num(b.x, `liquid.bodies[${i}].x`); num(b.z, `liquid.bodies[${i}].z`); num(b.r, `liquid.bodies[${i}].r`); num(b.y, `liquid.bodies[${i}].y`); }
      else {
        need(Array.isArray(b.pts) && b.pts.length >= 2, `liquid.bodies[${i}].pts needs two points`);
        num(b.width, `liquid.bodies[${i}].width`);
        num(b.y0, `liquid.bodies[${i}].y0`);
        num(b.y1, `liquid.bodies[${i}].y1`);
      }
    }
  }

  /* ---- props ---------------------------------------------------------- */
  const props = d.props ?? [];
  const propIds = new Set();
  for (let i = 0; i < props.length; i++) {
    const p = props[i];
    need(typeof p.id === 'string' && !propIds.has(p.id), `props[${i}].id must be unique`);
    propIds.add(p.id);
    need(PROP_KINDS.has(p.kind), `props[${i}].kind "${p.kind}" unknown - one of ${[...PROP_KINDS].join(', ')}`);
    validateRegion(p.region, `props[${i}].region`);
    num(p.count, `props[${i}].count`);
  }

  /* ---- minerals ------------------------------------------------------- *
   * Everything here throws rather than warns, and the list of what it throws
   * on is the list of ways a mineral table lies: a rarity that costs nothing
   * to reach, a value ladder that does not ascend, a "rare" ore there are more
   * of than the common one, and a per-node price hand-written next to the
   * volume and the unit value it is supposed to be the product of.           */
  const minerals = [];
  const rawMinerals = d.minerals ?? [];
  need(rawMinerals.length > 0, 'a planet with nothing to mine is a planet nobody flies to');
  const mIds = new Set();
  for (let i = 0; i < rawMinerals.length; i++) {
    const m = rawMinerals[i];
    const at = `minerals[${i}]`;
    need(typeof m.id === 'string' && /^[a-z][a-z0-9_]*$/.test(m.id), `${at}.id "${m.id}" must be lower_snake`);
    need(!mIds.has(m.id), `${at}.id "${m.id}" is not unique`);
    mIds.add(m.id);
    need(typeof m.name === 'string' && m.name.length > 0, `${at}.name is required`);
    need(typeof m.item === 'string' && /^[a-z][a-z0-9_]*$/.test(m.item),
      `${at}.item must name the ITEMS row this ore becomes - an ore with no item is cargo nobody can price`);
    need(MINERAL_RARITY.includes(m.rarity),
      `${at}.rarity "${m.rarity}" unknown - one of ${MINERAL_RARITY.join(', ')}`);
    need(MINERAL_TERRAINS.includes(m.terrain),
      `${at}.terrain "${m.terrain}" unknown - one of ${MINERAL_TERRAINS.join(', ')}`);
    need(typeof m.place === 'string' && m.place.length > 0,
      `${at}.place must name the feature this seam is in - "somewhere on the planet" is not a destination`);
    validateRegion(m.region, `${at}.region`);
    num(m.count, `${at}.count`);
    need(m.count >= 1, `${at}.count must be at least 1`);
    num(m.size, `${at}.size`);
    need(m.size > 0, `${at}.size must be positive - it is both the node radius and its hold volume`);
    num(m.unitValue, `${at}.unitValue`);
    need(m.unitValue > 0, `${at}.unitValue must be positive`);
    const spread = m.spread ?? 0.25;
    num(spread, `${at}.spread`);
    need(spread >= 0 && spread <= 0.5, `${at}.spread must be 0..0.5, got ${spread}`);
    /* Refused, not overwritten. A descriptor that hands in a credits range and
     * silently has it replaced is a descriptor whose author believes a number
     * that is not in the build. */
    need(m.credits === undefined,
      `${at}.credits is DERIVED from unitValue * hold and must not be authored - delete it`);

    const hold = holdUnitsFor(m.size);
    const mid = m.unitValue * hold;
    minerals.push(Object.freeze({
      id: m.id,
      item: m.item,
      name: m.name,
      rarity: m.rarity,
      terrain: m.terrain,
      place: m.place,
      color: m.color ?? 0xffffff,
      glow: m.glow ?? 0,
      unitValue: m.unitValue,
      spread,
      size: m.size,
      hold,
      credits: Object.freeze([Math.round(mid * (1 - spread)), Math.round(mid * (1 + spread))]),
      count: m.count,
      spacing: m.spacing ?? 0,
      region: Object.freeze({ ...m.region }),
    }));
  }

  /* ---- and the ladder those rarities claim to be ----------------------- */
  const tiers = MINERAL_RARITY
    .map((r) => ({ rarity: r, of: minerals.filter((m) => m.rarity === r) }))
    .filter((t) => t.of.length > 0);
  const firstTier = MINERAL_RARITY.indexOf(tiers[0].rarity);
  need(firstTier === 0,
    `the rarity ladder starts at "${tiers[0].rarity}" - a planet whose commonest ore is not common has no ladder, only a top`);
  for (let k = 1; k < tiers.length; k++) {
    const prev = tiers[k - 1];
    const here = tiers[k];
    need(MINERAL_RARITY.indexOf(here.rarity) === MINERAL_RARITY.indexOf(prev.rarity) + 1,
      `the rarity ladder skips from "${prev.rarity}" to "${here.rarity}" - the rungs between them are what make the top rung mean anything`);
    const dearestBelow = Math.max(...prev.of.map((m) => m.unitValue));
    const cheapestHere = Math.min(...here.of.map((m) => m.unitValue));
    need(cheapestHere > dearestBelow,
      `${here.rarity} ore at ${cheapestHere} cr/m3 is not worth more than ${prev.rarity} ore at ${dearestBelow} cr/m3`);
    const scarcestBelow = Math.min(...prev.of.map((m) => m.count));
    const commonestHere = Math.max(...here.of.map((m) => m.count));
    need(commonestHere <= scarcestBelow,
      `there are ${commonestHere} nodes of a ${here.rarity} ore against ${scarcestBelow} of a ${prev.rarity} one - that is not rarity, that is a name`);
  }
  /* The top rung has to COST something to stand on. This is the reachability
   * defect stated in the one place it can be caught for free: a probe can
   * prove a node is walkable to, but only the table knows whether the walk was
   * ever meant to be worth anything.
   *
   * Skipped when `common` is the only tier there is. A planet with one grade
   * of ore is making no claim about rarity, and refusing to let it lie on the
   * flat would be refusing the honest case in the name of the dishonest one. */
  /* ── IT APPLIES TO `rare` AS WELL AS TO THE TOP RUNG, AND IT DID NOT ────
   *
   * This used to check only `tiers[tiers.length - 1]`. On a four-tier planet
   * that is `exotic`, so **a `rare` ore scattered over the whole playfield in
   * open ground was legal** - the exact thing the sentence below refuses,
   * permitted one rung down. Found while re-deriving the rare tier's cost rule:
   * a mutant planet with `rarity: 'rare', terrain: 'plain', region: field` was
   * accepted by this validator without complaint.
   *
   * `rare` and `exotic` are the two rungs that are supposed to be somewhere.
   * `uncommon` is deliberately NOT included - Cinder's ferrobasalt is 20 m from
   * a pad on purpose, and a ladder whose second rung already costs a march has
   * nowhere left to go.
   *
   * Still skipped when `common` is the only tier: a planet with one grade of
   * ore is making no claim about rarity, and refusing to let it lie on the flat
   * would be refusing the honest case in the name of the dishonest one. */
  /* THE UNION, and the first draft of this got it wrong in a way worth keeping.
   *
   * I replaced "the top rung" with "rare and exotic" — and that silently STOPPED
   * catching a scattered top rung on a TWO-tier planet, where the top is
   * `uncommon`. The suite caught it immediately ("Missing expected exception:
   * the rarest ore lying on the flat"), which is the case doing exactly its job.
   *
   * Both halves are true and neither implies the other: the TOP rung must cost
   * something whatever it is called, AND `rare`/`exotic` must cost something
   * even when they are not the top. So it is the union of the two. */
  const SOMEWHERE = new Set(['rare', 'exotic']);
  const top = tiers[tiers.length - 1];
  const mustBeSomewhere = tiers.length > 1
    ? [...new Set([
      ...(top.rarity === 'common' ? [] : top.of),
      ...tiers.filter((t) => SOMEWHERE.has(t.rarity)).flatMap((t) => t.of),
    ])]
    : [];
  for (const m of mustBeSomewhere) {
    need(m.terrain !== 'plain',
      `the ${m.rarity} ore "${m.id}" is in terrain 'plain' - a rare element on the flat is a common element with a better name`);
    need(m.region.shape !== 'field',
      `the ${m.rarity} ore "${m.id}" scatters over the whole playfield - put it somewhere`);
  }

  /* ---- landing sites, and the promise they make ------------------------ */
  const landing = d.landing ?? [];
  need(landing.length > 0, 'a planet you cannot land on is a skybox');
  const pads = forms.filter((f) => f.kind === 'pad');
  let primaries = 0;
  for (let i = 0; i < landing.length; i++) {
    const s = landing[i];
    need(typeof s.id === 'string', `landing[${i}].id is required`);
    num(s.x, `landing[${i}].x`); num(s.z, `landing[${i}].z`); num(s.r, `landing[${i}].r`);
    if (s.primary) primaries++;
    /* The pad has to EXIST in the height field, and it has to be at least as
     * big as the site claims. This is the whole "built but not reachable"
     * defect caught at definition time: a site record on its own is a promise
     * with nothing behind it, and the flatness test downstream would then be
     * measuring the noise floor of an ash plain. */
    const pad = pads.find((f) => Math.hypot(f.x - s.x, f.z - s.z) < 1e-6);
    need(pad, `landing site "${s.id}" at (${s.x}, ${s.z}) has no matching pad landform in terrain.landforms`);
    need(pad.r >= s.r, `landing site "${s.id}" claims r=${s.r} but its pad levels only r=${pad.r}`);
  }
  need(primaries === 1, `exactly one landing site must be primary, found ${primaries}`);

  const spawnSite = landing.find((s) => s.primary);

  return Object.freeze({
    id: d.id,
    name: d.name,
    blurb: d.blurb ?? '',
    half,
    seg,
    gravity: d.gravity,
    terrain: Object.freeze(terrain),
    palette: Object.freeze({ ...palette, patch: Object.freeze(patches) }),
    sky: Object.freeze(sky),
    liquid: liquid ? Object.freeze(liquid) : null,
    props: Object.freeze(props),
    minerals: Object.freeze(minerals),
    landing: Object.freeze(landing),
    spawn: Object.freeze({ site: spawnSite.id, x: spawnSite.x, z: spawnSite.z, yaw: spawnSite.yaw ?? 0 }),
    hazards: Object.freeze(d.hazards ?? {}),
  });
}

export { REGION_SHAPES, PROP_KINDS };
