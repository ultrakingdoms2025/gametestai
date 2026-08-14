/**
 * Aldermoor Vale's road network, and the crossings that stitch its two banks
 * together.
 *
 * The table used to live in `MedievalWorld.js` as a bare `ROADS` const. It
 * moved here for the same reason `MedievalHeight.js` and `Settlements.js` did,
 * and the reason is sharper for roads than for either of them: **the property
 * that matters about a road network is not what it looks like, it is whether
 * you can get anywhere on it**, and that is a graph question that needs no
 * renderer at all. A 900 m map with five towns on two banks of a river can be
 * disconnected in a way that no screenshot shows and no exception reports - a
 * town is simply unreachable, and the only symptom is a player walking into
 * water.
 *
 * Nothing in this file may import `three` or touch the DOM. `MedievalWorld`
 * imports `ROADS` straight back and turns each entry into a
 * `CatmullRomCurve3`, so there is still exactly one definition of where every
 * road runs.
 *
 * ---------------------------------------------------------------------------
 * HOW A JUNCTION IS MADE
 *
 * Catmull-Rom passes through every one of its control points, so two roads
 * that SHARE a control point meet exactly, on the curve, whatever the spline
 * tension does between the points. Every ring road below therefore begins at a
 * control point copied verbatim from the road it branches off - `westway`
 * starts at the vale drove road's `[-31, 20]`, `blackmarchway` at the east
 * road's `[262, 76]`, and so on. That is what makes `roadGraph` below a proof
 * rather than an estimate: connectivity is established at authored points, not
 * at a place two splines happen to pass near.
 *
 * The old vale's seven roads predate that discipline and merely come close to
 * one another (the castle road ends at `[34, 15]`, the high road starts at
 * `[34, 20]`), so the graph joins on proximity as well - see `ROAD_JOIN`.
 *
 * ---------------------------------------------------------------------------
 * WHY CROSSINGS ARE EDGES AND FORDS ARE NOT
 *
 * A ford is a piece of ROAD: `_roadRibbon` conforms to the heightfield, the
 * heightfield dips through 39 cm of water at Ashlea and Harrowgate, and the
 * player wades across a continuous ribbon. The polyline is unbroken, so the
 * graph is too, and nothing has to be declared.
 *
 * A bridge is not. The stone bridge at x = 26 spans a channel the road ribbon
 * does not cross: `bridgeN` stops at `[26, 103]` and `bridgeS` restarts at
 * `[26, 129]`, twenty-six metres away, because the deck between them is
 * masonry built by `_buildRiverside` rather than cobble laid by `_buildRoads`.
 * A graph built from polylines alone would report the vale's own bridge as a
 * break in the network. So every bridge declares the two road points its deck
 * joins, and those become graph edges - which also means a bridge that is
 * moved and forgets to move its abutments fails the reachability test instead
 * of stranding half the map.
 */

/* ------------------------------------------------------------------ */
/* The old vale                                                        */
/* ------------------------------------------------------------------ */

/**
 * The seven roads of the original 400 m vale, verbatim.
 *
 * Not renumbered, not reordered and not resampled: these are the streets the
 * village, the market and the castle approach were composed against, and the
 * loose setts, the village lanes and the minimap all key off them.
 */
export const VALE_ROADS = [
  // The castle road is the spine of the whole vale: it is the one thing that
  // tells a player standing in the market which way the landmark is. Widened
  // to 7.6m so it survives as a readable ribbon at 110m.
  { key: 'castle', width: 7.6, pts: [[-14, -58], [-8, -47], [0, -34], [4, -20], [11, -6], [21, 4], [34, 15]] },
  /* The vale drove road.
   *
   * The castle road above joins the market to the gate, but it runs up the
   * *east* side of the keep - so from the composed castle-approach vantage,
   * which stands due south of the keep, there was no path in frame at all: a
   * player would have a landmark to look at and no route to it, and the eye
   * had nothing to follow from the bottom of the frame to the subject. This
   * track runs south-to-north straight up that sightline and merges into the
   * castle road at the gatehouse. It is kept at 18m or more from the castle
   * footprint the whole way so it never drops into the moat cut.
   */
  { key: 'vale', width: 6.2, pts: [[-45, 72], [-41, 56], [-37, 40], [-31, 20], [-25, 0], [-19, -16], [-14, -32], [-12, -46], [-14, -58]] },
  { key: 'high', width: 5.0, pts: [[34, 20], [50, 26], [66, 32], [82, 40], [96, 50]] },
  { key: 'bridgeN', width: 4.8, pts: [[32, 26], [29, 48], [27, 70], [26, 90], [26, 103]] },
  { key: 'bridgeS', width: 4.8, pts: [[26, 129], [27, 142], [31, 158], [38, 174]] },
  { key: 'church', width: 3.8, pts: [[36, 12], [46, 2], [56, -4], [66, -7]] },
  { key: 'mill', width: 3.4, pts: [[27, 74], [12, 80], [-2, 86], [-14, 93]] },
];

/* ------------------------------------------------------------------ */
/* The ring                                                            */
/* ------------------------------------------------------------------ */

/**
 * The expansion's roads.
 *
 * Every one of them is routed against the heightfield rather than drawn on a
 * plan: `medieval-roads.test.mjs` walks each polyline at half-metre spacing
 * and asserts the gradient never exceeds `MAX_GRADIENT`, that no control point
 * outside a declared ford sits under the waterline, and that the whole thing
 * stays inside the playfield. The routes below are the ones that survived
 * that - several obvious lines did not, and the two that failed hardest are
 * worth recording because they are the shape of the mistake:
 *
 *   - Running the west road straight along z = 40 to reach Ashlea Ford put
 *     130 m of carriageway INSIDE the channel, because the river swings 20 m
 *     north between x = -232 and x = -256 and a road drawn on a plan does not
 *     know that. The road now stays on the z = 20-26 shelf and turns south
 *     only once it is on the ford's own x.
 *
 *   - Climbing Grimscar Edge due west from the vale floor is a 69-77% face.
 *     The escarpment has exactly one walkable break, a diagonal shelf around
 *     z = -96 to -104, and the mining road takes it at 27-34% - which is why
 *     the town is where it is rather than somewhere prettier.
 */
export const RING_ROADS = [
  /* ---- West bank ------------------------------------------------- */
  /**
   * The west road: the vale drove road out to Ashlea Ford.
   *
   * Starts on the drove road's own `[-31, 20]` control point, runs the shelf
   * north of the river past the west parish church, and turns south onto the
   * ford's line at x = -268. The last two points are the ford's northern
   * approach ramp; the ford itself is the next road.
   */
  { key: 'westway', width: 5.6, pts: [[-31, 20], [-64, 26], [-100, 30], [-140, 28], [-178, 24], [-212, 22], [-240, 20], [-262, 28], [-268, 40]] },
  /**
   * Ashlea Ford, and the far-bank landing.
   *
   * Continuous across the water: the ribbon follows the heightfield down 1.6 m
   * into a 39 cm channel and back out. `RIVER_FEATURES` authored the bed, the
   * dropped flood plain and the 26 m bank set-back that make the approach a
   * ramp; this is the road that uses them.
   */
  { key: 'ashlea', width: 5.2, pts: [[-268, 40], [-268, 46], [-268, 51], [-268, 57], [-268, 64], [-272, 80], [-276, 96]] },
  /**
   * The strand road west along the far bank, through Reedwater to the braid.
   *
   * Stays on the 2-4 m shelf the whole way; the pool's own bank is the only
   * flat ground on this side of the river and it is why the fishing village is
   * where it is.
   */
  { key: 'reedway', width: 4.4, pts: [[-276, 96], [-292, 102], [-310, 108], [-326, 112], [-338, 116], [-352, 120], [-372, 124], [-390, 127], [-404, 128]] },
  /**
   * The abbey road: Ashlea Ford south to St Ceolwine's.
   *
   * Enters the combe through the one gap in its rim. The rim stands at 24-32 m
   * over three quarters of the circle and at 12.5-14.8 m on the north-east
   * arc, so the road crosses at (-239, 271) - measured off the finished
   * ground, not off the landform's declared gap bearing, because the gap's
   * bearing and its lowest ground are not the same thing once the ring's broad
   * relief is under it.
   */
  { key: 'abbeyway', width: 4.8, pts: [[-276, 96], [-278, 130], [-276, 168], [-270, 200], [-262, 232], [-250, 254], [-239, 271], [-244, 284], [-256, 292], [-272, 292]] },
  /**
   * The mining road up onto Grimscar bench.
   *
   * Branches off the west road at its `[-212, 22]` control point, crosses the
   * rising ground north-west to the foot of the scarp, and then climbs.
   *
   * `steep` is declared rather than discovered. The bench is 15.5 m below a
   * crest and 10 m above the plain, and the drop off its eastern lip is
   * authored as 15.5 m over a 14 m feather - 111% by construction. A gradient
   * map of the whole east face says the same thing everywhere: the gentlest
   * line onto the shelf, the diagonal from (-340, -84) to (-356, -116), runs
   * at 43-45% on 8 m samples and there is nothing better within 120 m in
   * either direction. That is not a routing failure, it is what an
   * escarpment IS - and it is exactly why a mining bench is a defensible
   * place to put a town and an awkward place to cart ore out of.
   */
  { key: 'grimscarway', width: 5.0, steep: true, pts: [[-212, 22], [-238, -6], [-262, -34], [-282, -58], [-300, -70], [-316, -76], [-330, -80], [-340, -84], [-346, -94], [-352, -104], [-357, -116], [-360, -132], [-362, -152], [-362, -176], [-360, -196]] },

  /* ---- East bank ------------------------------------------------- */
  /**
   * The east road: the high road out to Harrowgate Ford.
   *
   * Starts on the high road's own `[96, 50]` end point and keeps 50 m or more
   * north of the channel until it turns onto the ford's line.
   */
  { key: 'eastway', width: 5.6, pts: [[96, 50], [128, 54], [160, 52], [196, 54], [232, 62], [262, 76], [282, 96], [292, 110], [296, 118]] },
  /** Harrowgate Ford and its southern landing, under Blackmarch Bluff. */
  { key: 'harrowgate', width: 5.2, pts: [[296, 118], [296, 124], [296, 130], [294, 140], [292, 152], [288, 164]] },
  /** The northern approach to Harrowgate Bridge, off the east road. */
  { key: 'harrowbridgeN', width: 4.2, pts: [[296, 112], [304, 108], [311, 104]] },
  /** The bridge's southern landing, rejoining the ford road. */
  { key: 'harrowbridgeS', width: 4.2, pts: [[311, 138], [303, 143], [294, 150]] },
  /**
   * The Fenwick road: Harrowgate south-west to the basin's north notch.
   *
   * Fenwick's rim has three breaks and this uses the northern one, at
   * (196, 250) - measured off the finished ground rather than derived from the
   * basin's three-lobe gap phase, because the lobe minima and the lowest
   * GROUND are 25 degrees apart once the ring's broad relief is under them.
   * The road stays outside the rim on the 5-8 m shelf until it is on the
   * notch's own bearing, then turns and comes straight down the inner slope
   * into the market place.
   */
  { key: 'fenwickway', width: 5.4, pts: [[288, 164], [268, 186], [250, 206], [234, 220], [220, 228], [206, 234], [200, 240], [196, 250], [196, 274], [196, 300], [196, 324], [196, 338]] },
  /**
   * The march road: the east road north to Blackmarch Hold.
   *
   * The last four points are the approach up the bluff's one neck, and they
   * are why this road is declared `steep`. Taken head-on the neck is a 59-64%
   * face for 40 m; taken as this diagonal it is ~41% on 20 m samples. That is
   * the steepest thing in the network after Grimscar's incline and it is
   * deliberate: the whole point of the landform is that there is exactly one
   * way up and you are in view of the wall the entire time.
   */
  { key: 'blackmarchway', width: 5.0, steep: true, pts: [[262, 76], [258, 30], [256, -20], [258, -70], [260, -110], [258, -140], [257, -152], [272, -166], [286, -184], [300, -202], [310, -200], [320, -197], [330, -197]] },
  /**
   * The far-bank track: the stone bridge's southern road east to Fenwick.
   *
   * Starts on `bridgeS`'s own `[38, 174]` end point and ends on the Fenwick
   * road's `[200, 240]`. This is what makes the network a loop rather than two
   * dead-ended spurs - without it the only way back from Fenwick is the way
   * you came - and it is the road the hunters' camp sits on.
   *
   * It runs the z = 226-232 shelf rather than the obvious z = 240-248 line,
   * because the basin's north-west shoulder climbs to 17-21 m across x =
   * 144-179 at z = 249 and the direct route crossed it at 64%.
   */
  { key: 'farbank', width: 4.6, pts: [[38, 174], [52, 196], [70, 212], [92, 222], [118, 226], [148, 228], [176, 228], [196, 232], [200, 240]] },
  /**
   * Fenwick's west street, out through the basin's western notch.
   *
   * The rim's lowest ground on that arc is 2-4 m - BELOW the basin floor -
   * because the ground west of the bowl falls away into marsh. So this street
   * is the one approach to Fenwick that goes downhill on the way out, which is
   * why the wool barn and not the market is at the end of it.
   */
  { key: 'fenwickWest', width: 4.6, pts: [[196, 344], [176, 344], [152, 343], [128, 344], [106, 347]] },
  /** Fenwick's south street, out through the southern notch toward the rim. */
  { key: 'fenwickSouth', width: 4.4, pts: [[196, 350], [200, 366], [206, 388], [212, 412], [216, 434]] },
  /**
   * The pilgrim path: the abbey road east to the far-bank track.
   *
   * The second loop, and the one that makes the southern half of the map a
   * circuit: without it the abbey is reachable only from Ashlea Ford and every
   * pilgrim walking from Fenwick has to cross the river twice.
   */
  { key: 'pilgrimway', width: 3.8, pts: [[-262, 232], [-210, 236], [-158, 238], [-104, 236], [-52, 232], [-4, 224], [38, 206], [70, 214]] },
];

/** Every road in the vale, old and new, in build order. */
export const ROADS = [...VALE_ROADS, ...RING_ROADS];

/* ------------------------------------------------------------------ */
/* Crossings                                                           */
/* ------------------------------------------------------------------ */

/**
 * Every place the network gets from one bank to the other.
 *
 * `from`/`to` are the two ROAD points a crossing joins, and they are what
 * `roadGraph` turns into an edge. For a ford the two points are on the same
 * unbroken ribbon and the edge is redundant - it is declared anyway, because
 * "this is a crossing" is the thing the reachability test needs to be able to
 * enumerate, and a ford that silently stopped being wadeable should fail here
 * rather than in a screenshot.
 *
 * `deckY` and `span` are consumed by `MedievalWorld._buildCrossings`; a ford
 * has neither.
 */
export const CROSSINGS = [
  {
    id: 'aldern-bridge', name: 'The Aldern Bridge', kind: 'bridge', style: 'stone',
    x: 26, from: [26, 103], to: [26, 129], deckY: 4.35, span: 26, width: 7.0,
  },
  {
    id: 'ashlea-ford', name: 'Ashlea Ford', kind: 'ford', style: 'ford',
    x: -268, from: [-268, 40], to: [-268, 64], width: 5.2,
  },
  {
    /* A packhorse bridge beside the ford, not instead of it.
     *
     * The ford is 39 cm deep and perfectly walkable, so a bridge on the same
     * line would be scenery. Offset 12 m downstream it is a choice: carts and
     * cattle take the water, anyone on foot in winter takes the planks. Timber
     * trestle rather than masonry because this is the poor bank - the abbey's
     * road, not the king's.
     *
     * The abutments stand at z = 36 and z = 66 because that is where the
     * ground comes back above the waterline at this x: the ford reach drops
     * the flood plain to 2.05 m and pushes the bank set-back out to 26 m, so
     * the WET width here is 30 m even though the channel proper is 16. An
     * abutment authored on the channel edge would have stood in the river. */
    id: 'ashlea-planks', name: 'Ashlea Plank Bridge', kind: 'bridge', style: 'timber',
    x: -256, from: [-256, 36], to: [-256, 66], deckY: 2.92, span: 30, width: 2.6,
  },
  {
    id: 'harrowgate-ford', name: 'Harrowgate Ford', kind: 'ford', style: 'ford',
    x: 296, from: [296, 118], to: [296, 130], width: 5.2,
  },
  {
    /* The east crossing's real bridge, under the fort's eye: two segmental
     * arches on a mid-stream cutwater, with a toll house on the south
     * abutment. Blackmarch Hold exists to watch this, so it has to be worth
     * watching - a ford alone is a wet patch, a bridge is a chokepoint.
     *
     * Same abutment reasoning as Ashlea: dry ground is at z = 104 and z = 138,
     * so the span is 34 m and not the 15 m the channel measures. */
    id: 'harrowgate-bridge', name: 'Harrowgate Bridge', kind: 'bridge', style: 'stone',
    x: 311, from: [311, 104], to: [311, 138], deckY: 3.30, span: 34, width: 5.4,
  },
];

/**
 * Greyoak Braid's fishing stage - a crossing that deliberately is NOT one.
 *
 * The obvious move at a braided reach is a two-span causeway landing on the
 * gravel bar, and it was routed and then thrown away: the north bank at
 * x = -404 is the foot of Grimscar's dip slope, which climbs 28 m in the next
 * 28 m. A crossing there lands the player on a 100% face with nowhere to go,
 * which is a worse defect than no crossing at all because it looks like a
 * route.
 *
 * What survives is the half of it that made sense - a plank walk from
 * Reedwater's bank out to the shingle, where the fish traps are. It is a dead
 * end and it is meant to be, so it is not in `CROSSINGS`; `MedievalWorld`
 * builds it as part of Reedwater.
 */
export const GREYOAK_STAGE = {
  id: 'greyoak-stage', name: 'The Greyoak Stage',
  x: -404, fromZ: 128, toZ: 104, deckY: 2.6, width: 2.2,
};

/* ------------------------------------------------------------------ */
/* The graph                                                           */
/* ------------------------------------------------------------------ */

/**
 * How close two road centrelines have to come before a traveller can step from
 * one to the other, metres.
 *
 * Nine, because the narrowest road in the table is 3.4 m and the widest 7.6 m:
 * two centrelines 9 m apart are at worst 9 - 1.7 - 1.7 = 5.6 m of grass apart
 * and at best overlapping. It is a deliberately generous number and it is only
 * ever asked to certify junctions that the old vale authored by eye; every
 * junction added by this phase shares an exact control point, so it would
 * still pass at a tolerance of zero.
 */
export const ROAD_JOIN = 9;

/** Spacing the polylines are sampled at before the graph is built, metres. */
export const ROAD_SAMPLE = 2.5;

/**
 * Resample a road's control polyline at `ROAD_SAMPLE` spacing.
 *
 * Straight segments between control points, NOT the Catmull-Rom the world
 * draws. That is the conservative direction and it is worth being explicit
 * about why: the curve passes through every control point, so any junction
 * authored AT a control point exists on both the polyline and the curve. The
 * curve bulges away from the polyline between points, so a connection this
 * function reports on a straight chord could in principle be a couple of
 * metres wider on the curve - which is exactly what `ROAD_JOIN`'s slack is
 * sized for, and it is why the gradient walk in the tests uses the same
 * sampling rather than a second, prettier one.
 */
export function samplePolyline(pts, spacing = ROAD_SAMPLE) {
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, az] = pts[i];
    const [bx, bz] = pts[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const n = Math.max(1, Math.ceil(len / spacing));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      out.push([ax + (bx - ax) * t, az + (bz - az) * t]);
    }
  }
  out.push(pts[pts.length - 1].slice());
  return out;
}

/**
 * Undirected connectivity over the whole network.
 *
 * Nodes are polyline samples; edges are (a) consecutive samples on one road
 * and (b) any pair of samples within `join` metres, found through a uniform
 * hash rather than by comparing every pair - the network samples to roughly
 * 2,600 points and the quadratic is four million comparisons per call.
 *
 * @returns {{nodes:number[][], comp:Int32Array, find:(x:number,z:number)=>number}}
 */
export function roadGraph(roads = ROADS, crossings = CROSSINGS, join = ROAD_JOIN) {
  const nodes = [];
  const spans = [];
  for (const r of roads) {
    const first = nodes.length;
    for (const p of samplePolyline(r.pts)) nodes.push(p);
    spans.push([first, nodes.length]);
  }
  const n = nodes.length;
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i) => {
    while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
    return i;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  // Along each road.
  for (const [a, b] of spans) for (let i = a + 1; i < b; i++) union(i - 1, i);
  // Between roads: uniform hash at the join radius, so a probe touches nine
  // buckets and each bucket holds a handful of samples.
  const cell = join;
  const buckets = new Map();
  const key = (cx, cz) => cx * 100003 + cz;
  for (let i = 0; i < n; i++) {
    const k = key(Math.floor(nodes[i][0] / cell), Math.floor(nodes[i][1] / cell));
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(i);
  }
  const j2 = join * join;
  for (let i = 0; i < n; i++) {
    const cx = Math.floor(nodes[i][0] / cell);
    const cz = Math.floor(nodes[i][1] / cell);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const arr = buckets.get(key(cx + dx, cz + dz));
        if (!arr) continue;
        for (const j of arr) {
          if (j <= i) continue;
          const ddx = nodes[i][0] - nodes[j][0];
          const ddz = nodes[i][1] - nodes[j][1];
          if (ddx * ddx + ddz * ddz <= j2) union(i, j);
        }
      }
    }
  }
  // Bridges: the deck is not a road ribbon, so its two ends have to be joined
  // explicitly or the vale's own bridge reads as a break in the network.
  const nearest = (x, z) => {
    let best = -1;
    let bd = Infinity;
    for (let i = 0; i < n; i++) {
      const dx = nodes[i][0] - x;
      const dz = nodes[i][1] - z;
      const d = dx * dx + dz * dz;
      if (d < bd) { bd = d; best = i; }
    }
    return { i: best, d: Math.sqrt(bd) };
  };
  for (const c of crossings) {
    const a = nearest(c.from[0], c.from[1]);
    const b = nearest(c.to[0], c.to[1]);
    if (a.d <= join && b.d <= join) union(a.i, b.i);
  }
  const comp = new Int32Array(n);
  for (let i = 0; i < n; i++) comp[i] = find(i);
  return {
    nodes,
    comp,
    /** Index of the road sample nearest (x, z), or -1 past `within`. */
    find(x, z, within = Infinity) {
      const r = nearest(x, z);
      return r.d <= within ? r.i : -1;
    },
    /** Distance from (x, z) to the nearest road centreline sample. */
    distance(x, z) {
      return nearest(x, z).d;
    },
    /** True when a traveller can walk from A to B on roads and crossings. */
    connects(ax, az, bx, bz, within = 26) {
      const a = nearest(ax, az);
      const b = nearest(bx, bz);
      if (a.d > within || b.d > within) return false;
      return comp[a.i] === comp[b.i];
    },
  };
}
