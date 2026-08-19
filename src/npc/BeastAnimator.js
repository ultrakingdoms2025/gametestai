import * as THREE from 'three';
import { gaitFor, legPhase, legPose, planted, GAIT_PHASE } from './BeastGait.js';
import { BEASTS, isPredator } from './BeastSpecies.js';

/**
 * Poses a {@link BeastBody} from a gait table.
 *
 * ── Why not NPCAnimator ───────────────────────────────────────────────────
 * `NPCAnimator` cannot drive four legs, and not by a small margin: `this.feet`
 * is a two-element array, the phase relationship between them is the literal
 * `foot.side > 0 ? 0 : 0.5` at NPCAnimator.js:642 - one antiphase, permanently -
 * and every bone it touches is looked up by biped name. There is no four-legged
 * animal hiding inside it, so beasts get their own animator and `NPC` chooses
 * between the two through `_createAnimator` (see the seam note in NPC.js).
 *
 * ── What this actually does ───────────────────────────────────────────────
 * Everything is driven off ONE number - the stride phase - which advances with
 * DISTANCE TRAVELLED rather than with time. That is the whole trick, and it is
 * the same one `Horse.update` uses: feet that advance with time skate whenever
 * the animal changes speed, and a skating foot is the single most obvious tell
 * that a quadruped is a puppet.
 *
 * On top of the legs sit the things that separate a walk from a charge to the
 * eye, none of which are leg timing:
 *
 *   - the body bobs twice a stride and FLEXES along its length, so the animal
 *     looks like it is driving off its hind legs rather than being pushed;
 *   - the head nods against the body, and drops as the animal commits;
 *   - the ears pin flat at speed and flick at rest;
 *   - the tail streams, and drops between the legs when the beast is beaten.
 *
 * ── The telegraph ─────────────────────────────────────────────────────────
 * `setIntent` is the AI's only channel into the pose, and it exists so that an
 * incoming maul is READABLE. A wolf crouches and opens its jaws through the
 * wind-up; a bear rears, lifts a paw and turns its shoulders. Both hold that
 * shape for the whole telegraph and snap out of it on the strike, so a player
 * watching the animal - rather than the health bar - can step out of the arc.
 *
 * ── And the animal that has no telegraph ──────────────────────────────────
 * A camel is not a predator, so three of the five intent weights - crouch, rear
 * and gape - have no meaning on it, and the state machine that would set them
 * was written for hunters. `setIntentForState` therefore forks on the species
 * ONCE, at the top, and the herbivore path (`_setPreyIntent`) can only ever
 * reach the two weights that a prey animal actually expresses. Two other things
 * are its alone and neither touches the predator path: the pace ROLL, added in
 * `update` only when the gait declares one, and the CUD, a chewing jaw for an
 * animal standing still.
 */

const clamp = THREE.MathUtils.clamp;
const damp = THREE.MathUtils.damp;
const TAU = Math.PI * 2;

const _look = new THREE.Vector3();
const _headWorld = new THREE.Vector3();

/** How long a corpse takes to sink out of sight once the sink is asked for. */
const SINK_TIME = 3.0;
/** How far it sinks. Comfortably past the tallest beast. */
const SINK_DEPTH = 2.2;

export class BeastAnimator {
  /**
   * @param {{body:import('./BeastBody.js').BeastBody, species:string,
   *          seed?:number, bus?:any, owner?:any}} ctx
   */
  constructor({ body, species = 'wolf', seed = 1, bus = null, owner = null }) {
    this.body = body;
    this.species = species;
    this.bus = bus;
    this.owner = owner;

    /**
     * Does this animal's pose vocabulary include predation?
     *
     * Everything below the intent layer - legs, bob, flex, nod, ears, tail,
     * death - is quadruped and shared. What is NOT shared is what a STATE means
     * as a SHAPE: a wolf stalking crouches and half-opens its jaws, and there
     * is no reading of a camel doing either. `setIntentForState` branches on
     * this once and the two paths never meet, so a herbivore cannot be handed a
     * crouch by a state machine that was written for hunters.
     *
     * Absent means predator - see `isPredator` - so the wolf and the bear take
     * the path they always did, byte for byte.
     */
    this._predator = isPredator(BEASTS[species]);

    this.speed = 0;
    this.turnRate = 0;
    this.stridePhase = 0;
    this.gait = gaitFor(species, 0);

    /* Intent, written by the AI and smoothed here. Every one of these is a
     * 0..1 weight rather than a boolean so nothing ever snaps. */
    this._want = { gape: 0, crouch: 0, rear: 0, alert: 0, cower: 0 };
    this._have = { gape: 0, crouch: 0, rear: 0, alert: 0, cower: 0 };

    this._lookTarget = null;
    this._headYaw = 0;
    this._headPitch = 0;

    this._flinch = 0;
    this._flinchDir = new THREE.Vector3();

    this.dead = false;
    this.sunk = false;
    this._deathT = 0;
    this._deathRoll = 0;
    this._sinking = false;
    this._sinkT = 0;

    this._time = 0;
    let s = (seed >>> 0) || 11;
    this._rnd = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
    this._flickOffset = this._rnd() * TAU;
  }

  /* ---------------------------------------------------------------- */
  /* The interface NPC drives                                          */
  /* ---------------------------------------------------------------- */

  setLocomotion(speed, turnRate) {
    this.speed = speed ?? 0;
    this.turnRate = turnRate ?? 0;
  }

  setLookTarget(v) {
    this._lookTarget = v ?? null;
  }

  /**
   * The AI's channel into the pose.
   * @param {{gape?:number, crouch?:number, rear?:number, alert?:number, cower?:number}} intent
   */
  setIntent(intent) {
    const w = this._want;
    if (intent.gape !== undefined) w.gape = clamp(intent.gape, 0, 1);
    if (intent.crouch !== undefined) w.crouch = clamp(intent.crouch, 0, 1);
    if (intent.rear !== undefined) w.rear = clamp(intent.rear, 0, 1);
    if (intent.alert !== undefined) w.alert = clamp(intent.alert, 0, 1);
    if (intent.cower !== undefined) w.cower = clamp(intent.cower, 0, 1);
  }

  /**
   * What a state looks like.
   *
   * The AI reports where it is in its own state machine; deciding what that
   * should LOOK like belongs here, next to the weights that express it. The
   * two species read completely differently for the same state, and that is
   * the point: a wolf crouches to spring and a bear stands up to swing, so a
   * player who has met one still has to read the other.
   *
   * @param {{state:string, phase:string, wind:number, hunting:boolean,
   *          stalking:boolean}} s
   */
  setIntentForState(s) {
    if (!this._predator) {
      this._setPreyIntent(s);
      return;
    }
    if (s.state === 'ATTACK') {
      if (s.phase === 'telegraph') {
        this.setIntent({
          crouch: this.species === 'wolf' ? s.wind : 0,
          rear: this.species === 'bear' ? s.wind : 0,
          gape: s.wind * 0.9,
          alert: 1,
          cower: 0,
        });
      } else if (s.phase === 'strike') {
        // Snap shut. The jaws close ON the blow, which is the frame that reads.
        this.setIntent({ crouch: 0, rear: 0, gape: 0, alert: 1, cower: 0 });
      } else {
        // Recovering: mouth half open, still fixed on you, and wide open to a
        // counter-attack. The pose is the punish window made visible.
        this.setIntent({ crouch: 0, rear: 0, gape: 0.25, alert: 0.8, cower: 0 });
      }
      return;
    }
    if (s.state === 'FLEE') {
      this.setIntent({ crouch: 0, rear: 0, gape: 0.15, alert: 0, cower: 1 });
      return;
    }
    this.setIntent({
      crouch: s.stalking ? 0.55 : 0,
      rear: 0,
      gape: s.hunting ? 0.2 : 0,
      alert: s.hunting ? 1 : 0.35,
      cower: 0,
    });
  }

  /**
   * What a state looks like on an animal that does not hunt.
   *
   * Three of the five intent weights are structurally unavailable here and that
   * is the entire content of this method:
   *
   *   - `crouch` is a wolf gathering itself to spring. A camel that dropped its
   *     chest would read as a camel sitting down, which is a completely
   *     different and much more specific animal behaviour than anything the AI
   *     is trying to say.
   *   - `rear` is a bear standing up to swing. There is nothing to swing.
   *   - `gape` is the bite telegraph. The jaw still moves on a herbivore - see
   *     the chew in `update` - but never because the AI asked for a mouth.
   *
   * What is left is the pair that actually carry a prey animal's mood, and they
   * run the OPPOSITE way round from a predator's. A wolf is most alert when it
   * is closing; a camel is most alert when something has just hurt it and it is
   * about to leave, and the rest of the time it is a head-down grazing animal
   * paying no attention to anybody. That is `alert`, which lifts the head and
   * points the ears, and `cower`, which pins them back and drops the tail.
   *
   * `cower` is deliberately held at 0.5 rather than the predator FLEE path's
   * 1.0: at 1.0 the tail clamps flat between the legs, which is a dog's fear
   * signal and not a camel's - a bolting camel carries its tail UP. Half of it
   * pins the ears, which is the part that is true, without the part that is not.
   *
   * `BeastNPC` can only ever hand a camel three of the five states it publishes
   * - ROAM, FLEE and a STALK that is overwritten inside the same call - and the
   * ATTACK branch above is unreachable for it. This method still answers for
   * every state anyway: a pose driver that assumes its caller's state machine
   * is smaller than it says is a pose driver that breaks the day somebody
   * spawns a camel some other way.
   *
   * @param {{state:string, phase:string, wind:number, hunting:boolean,
   *          stalking:boolean}} s
   */
  _setPreyIntent(s) {
    if (s.state === 'FLEE') {
      this.setIntent({ crouch: 0, rear: 0, gape: 0.2, alert: 0.15, cower: 0.5 });
      return;
    }
    this.setIntent({
      crouch: 0,
      rear: 0,
      gape: 0,
      // `hunting` on a herbivore means "something is still on my mind" - the
      // only way it has a target at all is that the thing hit it.
      alert: s.hunting ? 0.85 : 0.2,
      cower: 0,
    });
  }

  /** A beast is never furniture-bound; the hook exists because `NPC` calls it. */
  setSeated() {}
  /** Aiming is a biped concept. Present so shared code paths cannot throw. */
  setAiming() {}
  setAimTarget() {}
  setGesturing() {}
  setPosture() {}

  /** Take a hit: a shudder along the direction the blow travelled. */
  flinch(dir, hard = false) {
    this._flinch = hard ? 1 : 0.55;
    if (dir) this._flinchDir.copy(dir).normalize();
  }

  /**
   * Collapse.
   *
   * A quadruped dies by folding its legs and rolling onto its side, which is
   * two rotations and a drop - and is far more readable at distance than any
   * amount of limb detail, because the silhouette changes completely.
   */
  die(dir, headshot = false) {
    if (this.dead) return;
    this.dead = true;
    this._deathT = 0;
    // Roll away from the blow, so a shot from the left drops it to the right.
    const side = dir && dir.x !== 0 ? Math.sign(dir.x) : (this._rnd() < 0.5 ? -1 : 1);
    this._deathRoll = side * (1.15 + this._rnd() * 0.4);
    this._want.gape = headshot ? 0.5 : 0.2;
  }

  revive() {
    this.dead = false;
    this.sunk = false;
    this._sinking = false;
    this._sinkT = 0;
    this._deathT = 0;
    this._flinch = 0;
    for (const k of Object.keys(this._want)) {
      this._want[k] = 0;
      this._have[k] = 0;
    }
    const b = this.body;
    b.tilt.position.set(0, 0, 0);
    b.tilt.rotation.set(0, 0, 0);
    b.root.visible = true;
  }

  /** Start the corpse sinking; `sunk` latches when it is out of sight. */
  beginSink() {
    if (!this.dead || this._sinking) return;
    this._sinking = true;
    this._sinkT = 0;
  }

  /* ---------------------------------------------------------------- */
  /* Pose                                                              */
  /* ---------------------------------------------------------------- */

  /**
   * @param {number} dt seconds since this animator last posed (LOD-banded)
   * @param {number} elapsed
   * @param {{detail:boolean, ik:boolean, distance:number}} lod
   */
  update(dt, elapsed, lod) {
    this._time += dt;
    const b = this.body;

    if (this.dead) {
      this._poseDead(dt);
      return;
    }

    /* ---- stride phase: distance, never time ---- */
    const speed = Math.abs(this.speed);
    this.gait = gaitFor(this.species, speed);
    const gait = this.gait;
    if (gait.stride > 0) {
      this.stridePhase = (this.stridePhase + (speed * dt) / gait.stride) % 1;
    }

    /* ---- intent smoothing ---- */
    const h = this._have;
    const w = this._want;
    // The gape tracks fastest: a bite that eases open is not a bite.
    h.gape = damp(h.gape, w.gape, 18, dt);
    h.crouch = damp(h.crouch, w.crouch, 8, dt);
    h.rear = damp(h.rear, w.rear, 7, dt);
    h.alert = damp(h.alert, w.alert, 6, dt);
    h.cower = damp(h.cower, w.cower, 5, dt);

    this._flinch = Math.max(0, this._flinch - dt * 4);

    /* ---- legs ---- */
    const offsets = GAIT_PHASE[gait.name] ?? GAIT_PHASE.stand;
    const legs = b.legs;
    // A reared bear takes its forelegs off the ground entirely; they hang and
    // paw at the air rather than continuing to walk.
    const rear = h.rear;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      const t = legPhase(this.stridePhase, offsets[i]);
      const pose = legPose(t, gait, leg.front);

      let swing = pose.swing;
      let fold = pose.fold;
      let lift = pose.lift;
      if (leg.front && rear > 0.01) {
        // Forelegs drawn up and cocked, ready to come down.
        swing = THREE.MathUtils.lerp(swing, 0.95 + Math.sin(this._time * 6) * 0.12, rear);
        fold = THREE.MathUtils.lerp(fold, 1.5, rear);
        lift = THREE.MathUtils.lerp(lift, 0, rear);
      }

      leg.upper.rotation.x = swing;
      leg.lower.rotation.x = -fold;
      leg.upper.position.y = leg.hipY + lift * 0.35;

      if (planted(leg.prevT, t, gait) && speed > 0.5 && this.bus) {
        this.bus.emit('beast:footfall', {
          beast: this.owner,
          species: this.species,
          leg: i,
          position: b.root.position,
          hard: clamp(speed / 8, 0.12, 1),
        });
      }
      leg.prevT = t;
    }

    /* ---- body attitude ---- */
    const sp01 = clamp(speed / 8, 0, 1);
    const drive = sp01 * sp01;
    const bob = Math.sin(this.stridePhase * TAU * 2) * gait.bob;
    // Crouching drops the whole animal; rearing lifts the front of it.
    const crouchDrop = h.crouch * b.height * 0.12;
    b.tilt.position.y = bob - crouchDrop + h.rear * b.height * 0.30;
    b.tilt.position.z = h.rear * b.height * 0.12;

    // Flex along the length twice a stride: the bunch-and-extend that makes an
    // animal look like it is driving itself forward.
    const flex = Math.sin(this.stridePhase * TAU * 2) * gait.bob * 0.9 * (0.35 + drive);
    b.tilt.rotation.x = flex - h.crouch * 0.10 - h.rear * 0.62 + this._flinch * 0.10;
    // Lean into the turn, and shudder sideways when hit.
    const lean = clamp(this.turnRate * 0.16, -0.32, 0.32);
    b.tilt.rotation.z = damp(b.tilt.rotation.z, -lean * (0.4 + sp01), 8, dt)
      + this._flinch * this._flinchDir.x * 0.14;

    /* THE SHIP OF THE DESERT.
     *
     * A pacing animal lifts both legs on one side at once, so for half of every
     * cycle there is nothing under that side and the body falls toward it. That
     * roll is the single most recognisable thing about a camel in motion and it
     * is not something the leg tables can express on their own - the legs are
     * already in the right pattern, but the barrel above them has to answer.
     *
     * One sine per stride cycle, in phase with the pace: it peaks as the left
     * pair is airborne and troughs as the right pair is. Added rather than
     * damped so it cannot fight the turn lean above, and added ONLY when the
     * gait declares a roll - which no diagonal or staggered gait does, so the
     * wolf and the bear never reach this line at all. */
    const roll = gait.roll ?? 0;
    if (roll !== 0) b.tilt.rotation.z += Math.sin(this.stridePhase * TAU) * roll;
    b.tilt.rotation.y = damp(b.tilt.rotation.y, lean * 0.22, 8, dt);

    /* ---- neck + head ---- */
    // Head drops and reaches forward as the animal commits, lifts at rest, and
    // goes right down when it is stalking.
    const reachDown = drive * 0.30 + h.crouch * 0.34 - h.rear * 0.5 - h.cower * 0.25;
    const nod = Math.sin(this.stridePhase * TAU) * gait.bob * 2.4;
    b.neck.rotation.x = damp(b.neck.rotation.x, reachDown + nod, 12, dt);
    b.head.rotation.x = damp(b.head.rotation.x, -reachDown * 0.55 - nod * 0.6, 12, dt);

    this._trackLook(dt, lod);
    b.head.rotation.y = this._headYaw;
    b.head.rotation.x += this._headPitch;
    b.neck.rotation.y = damp(b.neck.rotation.y, this._headYaw * 0.45, 8, dt);

    /* ---- jaw ---- */
    b.jaw.rotation.x = h.gape * b.jawGape;

    /* THE CUD.
     *
     * A standing predator's mouth is shut and that is correct - a wolf's jaw
     * only opens to bite. A standing herbivore's mouth is never still, and at
     * the ranges a player actually meets one of these (measured recognition
     * distance for this project's animals is 15-20 m) a chewing jaw is the
     * cheapest possible signal that the thing is alive rather than placed.
     *
     * Two sines beating against each other so the rhythm wanders instead of
     * ticking, faded out with speed because an animal at a run is not eating,
     * and gated on `_predator` so no wolf ever chews. */
    if (!this._predator) {
      const chew = 0.5 + 0.5 * Math.sin(this._time * 5.2 + this._flickOffset)
        * Math.sin(this._time * 0.9 + this._flickOffset * 0.5);
      b.jaw.rotation.x += chew * b.jawGape * 0.30 * (1 - clamp(speed, 0, 1));
    }

    /* ---- ears ----
     * Forward and flicking when alert, pinned flat when charging or cowed.
     * Two rotations, and they carry the animal's mood better than anything
     * else on the model. */
    if (b.ears) {
      const pin = clamp(drive + h.rear * 0.6 + h.cower, 0, 1);
      const flick = Math.sin(this._time * 3.3 + this._flickOffset)
        * Math.sin(this._time * 1.27 + this._flickOffset);
      for (let i = 0; i < b.ears.length; i++) {
        const side = i === 0 ? -1 : 1;
        const ear = b.ears[i];
        ear.rotation.x = -h.alert * 0.24 + pin * 0.95 + (1 - pin) * flick * 0.16;
        ear.rotation.z = -side * (0.30 - h.alert * 0.16 + pin * 0.55);
      }
    }

    /* ---- tail ----
     * Level and streaming at speed, high when alert, clamped between the legs
     * when the beast has decided to leave. */
    const tailLift = -h.alert * 0.45 - sp01 * 0.35 + h.cower * 1.15;
    b.tail.rotation.x = damp(b.tail.rotation.x, tailLift, 7, dt);
    b.tail.rotation.z = Math.sin(this._time * 2.4 + this._flickOffset)
      * (0.16 - sp01 * 0.11) * (1 - h.cower);

    void elapsed;
  }

  /**
   * Turn the head toward whatever the AI is looking at.
   *
   * Clamped hard: a head that can rotate more than about 60 degrees off the
   * body reads as a broken neck, and on a quadruped the body should turn
   * instead - which is what the AI's `faceOverride` already does.
   */
  _trackLook(dt, lod) {
    const target = this._lookTarget;
    if (!target || (lod && lod.distance > 45)) {
      this._headYaw = damp(this._headYaw, 0, 6, dt);
      this._headPitch = damp(this._headPitch, 0, 6, dt);
      return;
    }
    const b = this.body;
    b.getHeadWorldPosition(_headWorld);
    _look.subVectors(target, _headWorld);
    const dist = _look.length();
    if (dist < 1e-3) return;

    // Into the head's own frame: the body yaw is already applied by the root.
    const bodyYaw = b.root.rotation.y;
    const sin = Math.sin(-bodyYaw);
    const cos = Math.cos(-bodyYaw);
    const lx = _look.x * cos - _look.z * sin;
    const lz = _look.x * sin + _look.z * cos;
    const yaw = clamp(Math.atan2(-lx, -lz), -1.05, 1.05);
    const pitch = clamp(Math.atan2(-_look.y, Math.hypot(lx, lz)), -0.5, 0.6);
    this._headYaw = damp(this._headYaw, yaw, 8, dt);
    this._headPitch = damp(this._headPitch, pitch, 8, dt);
  }

  /** Fold up, roll over, and eventually sink. */
  _poseDead(dt) {
    const b = this.body;
    this._deathT = Math.min(1, this._deathT + dt * 2.2);
    const t = this._deathT;
    // Ease-out: the collapse is fast and the settle is slow.
    const e = 1 - (1 - t) * (1 - t);

    b.tilt.rotation.z = this._deathRoll * e;
    b.tilt.rotation.x = -0.16 * e;
    b.tilt.position.y = -b.height * 0.30 * e;

    for (const leg of b.legs) {
      leg.upper.rotation.x = damp(leg.upper.rotation.x, leg.front ? 0.9 : -0.9, 5, dt);
      leg.lower.rotation.x = damp(leg.lower.rotation.x, -1.5, 5, dt);
    }
    b.neck.rotation.x = damp(b.neck.rotation.x, 0.55, 4, dt);
    b.head.rotation.x = damp(b.head.rotation.x, -0.2, 4, dt);
    b.head.rotation.y = damp(b.head.rotation.y, 0, 4, dt);
    b.jaw.rotation.x = damp(b.jaw.rotation.x, this._want.gape * b.jawGape, 4, dt);
    b.tail.rotation.x = damp(b.tail.rotation.x, 0.4, 4, dt);

    if (!this._sinking) return;
    this._sinkT = Math.min(SINK_TIME, this._sinkT + dt);
    const k = this._sinkT / SINK_TIME;
    b.tilt.position.y = -b.height * 0.30 - SINK_DEPTH * k * k;
    if (k >= 1 && !this.sunk) {
      this.sunk = true;
      b.root.visible = false;
    }
  }
}
