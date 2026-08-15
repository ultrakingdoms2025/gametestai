/**
 * Central tunables. Anything a designer would want to tweak lives here so that
 * gameplay feel can be adjusted without hunting through subsystems.
 */
export const CONFIG = {
  render: {
    // Device pixel ratio is clamped; beyond 2 the cost is not worth the pixels.
    maxPixelRatio: 2,
    fov: 75,
    near: 0.1,
    far: 2000,
    shadowMapSize: 2048,
    // Cascaded shadow split distances (metres from camera).
    shadowDistance: 120,
    exposure: 1.0,
  },

  postfx: {
    bloom: { strength: 0.55, radius: 0.5, threshold: 0.85 },
    ao: { radius: 0.5, intensity: 1.0, enabled: true },
    motionBlur: { enabled: false },
    vignette: 0.35,
    chromaticAberration: 0.0016,
    filmGrain: 0.018,
  },

  player: {
    height: 1.75,
    eyeHeight: 1.62,
    radius: 0.35,
    walkSpeed: 4.6,
    /**
     * The speed a sprint actually reaches, and it is NOT a free parameter.
     *
     * ── Where it comes from ───────────────────────────────────────────────
     * `Player._move` runs friction and then acceleration on every grounded
     * fixed step:
     *
     *     friction     v -= v * friction * dt            (above STOP_SPEED)
     *     accelerate   v += min(acceleration * dt, wish - v)
     *
     * so the fixed point is where the two cancel, `v * friction * dt =
     * acceleration * dt`, i.e. **v = acceleration / friction**. The step length
     * cancels out and so does the wish speed: `acceleration / friction` is the
     * ceiling on ANY grounded movement, and every wish at or above it lands on
     * exactly the same number. 82 / 10 = 8.2 m/s.
     *
     * ── This number used to be a lie, and then it was a demotion ──────────
     * It read 8.2 while the ratio was 60 / 10, so nothing in the game could go
     * 8.2 - a sprint measured 6.0 and so did a boosted sprint. That was first
     * fixed by writing 6.0 here, which made the config honest at the price of
     * making the sprint slower than it had ever claimed to be and leaving a
     * speed pickup that did nothing to a sprinting player.
     *
     * The owner's decision was to make 8.2 true instead, by moving the ratio:
     * `acceleration` went 60 -> 82 and `friction` was deliberately NOT touched.
     * @see acceleration for the measurements that chose between those two levers.
     *
     * Measured by driving the real controller across flat ground for 20 s with
     * the stamina gate removed (scripts/tests/player-speed.test.mjs re-runs all
     * of this):
     *
     *     walk                      4.6000 m/s     (below the cap: wish-limited)
     *     sprint                    8.2000 m/s     (the cap)
     *     crouch                    2.2000 m/s
     *     walk + 1.5x speed boost   6.9000 m/s     (= 1.5 * walkSpeed)
     *     sprint + 1.5x boost      12.3000 m/s     (= 1.5 * the cap)
     *     sprint + 3.0x boost      24.6000 m/s     (= 3.0 * the cap)
     *
     * The boosted rows are the second half of the same decision: a boost used
     * to scale only the WISH, which a sprint is already over, so it measured
     * exactly 8.2 at 1.5x and at 3.0x alike. `_move` now scales the grounded
     * `acceleration` by the same multiplier, which moves the cap with it.
     * @see ../player/Player.js `_move`
     *
     * With the stamina gate in play a sprint is not sustained at this speed:
     * the pool is 100 and drains at 15/s, so a held sprint is rationed to
     * roughly six and a half seconds before it drops back to a walk.
     *
     * ── What this number now tells you that 6.0 did not ───────────────────
     * A wolf charges at 7.6 and a bear at 6.4 (npc/BeastSpecies.js), and a
     * sprinting player at 8.2 outruns BOTH. That is the owner's call and the
     * beast speeds were left exactly as they were; the balance test in
     * scripts/tests/beast-combat.test.mjs now passes for the right reason
     * rather than on the strength of a constant that lied.
     *
     * @see sprintWishSpeed for the number the controller actually consumes.
     */
    sprintSpeed: 8.2,
    /**
     * The target handed to `_accelerate` while sprinting - a *wish*, not a
     * speed, and deliberately well above the cap above.
     *
     * Held at the same RATIO to the cap it has always had (8.2 / 6.0 = 1.367,
     * now 11.2 / 8.2 = 1.366) rather than at the same value, because both of
     * the things it is load-bearing for are ratios:
     *
     *   - The landing decay. `_accelerate` adds `min(acceleration * dt, wish -
     *     current)`, so while `current` is between the cap and the wish the
     *     wish is still pushing. `Parkour.tryLeap` SCALES standing velocity by
     *     1.42, so raising the cap raised the leap too: it used to land at
     *     6.0 * 1.42 = 8.52 and now lands at 8.2 * 1.42 = 11.64. Measured, the
     *     decay back to the cap takes 0.350 s at a wish of 11.2 - the same
     *     0.350 s it took at 6.0 and a wish of 8.2. Leaving the wish at 8.2
     *     would have put it AT the cap, and the landing then collapses in two
     *     steps: 11.644 -> 9.703 -> 8.200, measured, 0.033 s.
     *   - The FOV sprint kick, which normalises measured speed against this
     *     wish and so tops out at `6.5 * 8.2/11.2` = 4.759 degrees, against
     *     `6.5 * 6.0/8.2` = 4.756 before. Three thousandths of a degree, i.e.
     *     the look is unchanged. Leaving the wish at 8.2 would have saturated
     *     it at the full 6.5. @see ../player/Player.js `_applyFov`
     */
    sprintWishSpeed: 11.2,
    crouchSpeed: 2.2,
    /**
     * With `friction`, this sets the top ground speed outright:
     * `acceleration / friction` = 8.2 m/s. @see sprintSpeed
     *
     * ── Why this lever and not `friction` ─────────────────────────────────
     * The cap is a ratio, so 8.2 is reachable from either end: `acceleration:
     * 82` at `friction: 10`, or `acceleration: 60` at `friction: 7.317`. They
     * are not equivalent. `friction` is the ONLY thing that sheds momentum -
     * it is what stops you, what turns you, and what decays a landing - so
     * lowering it makes all three slower at once. Driven against the real
     * controller on flat ground, all reaching the same 8.2:
     *
     *                          60/10 (was)   82/10 (this)  70.1/8.55  60/7.317
     *     time to stop dead      0.267 s       0.283 s      0.333 s    0.400 s
     *     stopping distance      0.454 m       0.637 m      0.767 m    0.918 m
     *     180-degree turn, 95%   0.350 s       0.350 s      0.417 s    0.483 s
     *     ...carrying on past    0.121 m       0.166 m      0.209 m    0.258 m
     *     0 to 99% of top        0.433 s       0.433 s      0.500 s    0.600 s
     *     landing decay to cap   0.350 s       0.350 s      0.417 s    0.483 s
     *
     * Raising `acceleration` holds every one of those TIMES exactly where it
     * was; the only quantities that move are distances, and they move by the
     * speed ratio 8.2/6.0 = 1.367 because the player is covering ground faster
     * (0.121 * 1.367 = 0.166). That is what "faster" should cost. Lowering
     * `friction` instead buys the same top speed by taking 37% longer to stop
     * and to turn and letting the player carry twice as far past the turn,
     * which is the definition of skatey. Splitting the difference splits the
     * cost; it does not avoid it.
     *
     * What raising `acceleration` DOES cost is the standing start: a walk from
     * rest reaches 4.6 m/s in 0.083 s rather than 0.133 s, five frames instead
     * of eight. Both read as immediate, and no combination avoids it - holding
     * the walk ramp means holding `acceleration` at 60, which is lever B whole.
     * The 0.1 s friction time constant, which is what actually gives grounded
     * movement its character, is untouched.
     */
    acceleration: 82,
    airAcceleration: 12,
    /**
     * Deliberately NOT the lever that was moved to raise the sprint cap.
     * @see acceleration for the measurements.
     */
    friction: 10,
    jumpVelocity: 6.4,
    gravity: -22,
    maxHealth: 100,
    healthRegenDelay: 6.0,
    healthRegenRate: 8.0,
    // Stamina drives sprint, swimming and mantling. Regen is fast and starts
    // almost immediately: the pool exists to punctuate movement, not to ration
    // it. See systems/Stamina.js, which defaults these in if they are missing.
    maxStamina: 100,
    staminaRegenDelay: 0.9,
    staminaRegenRate: 24,
    sprintStaminaDrain: 15,
    swimStaminaDrain: 2.4,
    swimSprintStaminaDrain: 7,
    climbStaminaCost: 18,
    mouseSensitivity: 0.0022,
    stepHeight: 0.45,
    // Head-bob and view-kick keep the camera alive without inducing nausea.
    bobAmplitude: 0.035,
    bobFrequency: 9.5,
  },

  weapon: {
    machinegun: {
      name: 'VK-7 "Ripper"',
      rpm: 720,
      damage: 18,
      headshotMultiplier: 2.5,
      magazine: 40,
      reserve: 320,
      reloadTime: 2.1,
      spreadBase: 0.006,
      spreadMax: 0.055,
      spreadPerShot: 0.0055,
      spreadRecovery: 0.09,
      recoilVertical: 0.9,
      recoilHorizontal: 0.32,
      range: 300,
      muzzleVelocity: 620,
    },
  },

  npc: {
    friendlyCount: 6,
    hostileCount: 10,
    maxHealth: 100,
    walkSpeed: 1.5,
    runSpeed: 4.4,
    sightRange: 45,
    fieldOfView: 120, // degrees
    attackRange: 28,
    attackDamage: 8,
    attackInterval: 0.85,
    accuracy: 0.62,
    chatRange: 4.5,
    respawnDelay: 22,
  },

  portal: {
    radius: 2.4,
    height: 5.2,
    activationRange: 2.0,
    transitionDuration: 1.5,
  },

  minimap: {
    size: 220,
    range: 90, // world metres visible edge-to-edge
    zoomStep: 1.35,
  },

  debug: {
    // Toggled with F3 in-game; also settable via ?debug=1
    showStats: false,
    showColliders: false,
    freeCam: false,
  },
};

/** Read boolean flags from the query string, e.g. ?debug=1&world=medieval */
export function applyUrlOverrides() {
  const params = new URLSearchParams(location.search);
  if (params.get('debug') === '1') CONFIG.debug.showStats = true;
  if (params.get('colliders') === '1') CONFIG.debug.showColliders = true;
  return {
    startWorld: params.get('world') || null,
    // Screenshot/critique automation uses this to bypass the pointer-lock gate.
    autoStart: params.get('autostart') === '1',
    freeze: params.get('freeze') === '1',
    // ?dev=1 installs window.HARNESS for the automated visual review tooling.
    dev: params.get('dev') === '1',
  };
}
