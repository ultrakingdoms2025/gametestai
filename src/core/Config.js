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
     * ── This number used to be a lie ──────────────────────────────────────
     * It read 8.2, and nothing in the game could go 8.2. `Player._move` runs
     * friction and then acceleration on every grounded fixed step:
     *
     *     friction     v -= v * friction * dt            (above STOP_SPEED)
     *     accelerate   v += min(acceleration * dt, wish - v)
     *
     * so the fixed point is where the two cancel, `v * friction * dt =
     * acceleration * dt`, i.e. **v = acceleration / friction**. The step
     * length cancels out and so does the wish speed: 60 / 10 = 6.0 m/s is the
     * ceiling on ANY grounded movement, and every wish at or above it lands on
     * exactly the same 6.0.
     *
     * Measured by driving the real controller across flat ground for 20 s with
     * the stamina gate removed (scripts/tests/player-speed.test.mjs re-runs all
     * of this):
     *
     *     walk                      4.6000 m/s     (below the cap: honest)
     *     sprint                    6.0000 m/s     (against a config saying 8.2)
     *     walk + 1.5x speed boost   6.0000 m/s
     *     sprint + 1.5x boost       6.0000 m/s
     *     sprint + 3.0x boost       6.0000 m/s
     *
     * With the stamina gate in play a sprint is not even that: the pool is 100
     * and drains at 15/s, so a held sprint averages 5.885 m/s over four seconds
     * and 5.36 m/s over twelve.
     *
     * ── Two things this number now tells you that 8.2 did not ─────────────
     *   - A speed boost does nothing to a sprint. `boostSpeed` only scales the
     *     wish, and the wish is already above the cap.
     *   - A wolf charges at 7.6 and a bear at 6.4 (npc/BeastSpecies.js), so
     *     both of them OUTRUN a sprinting player. Reading 8.2 said the
     *     opposite, and a balance test in scripts/tests/beast-combat.test.mjs
     *     was asserting the opposite on the strength of it.
     *
     * @see sprintWishSpeed for the number the controller actually consumes.
     */
    sprintSpeed: 6.0,
    /**
     * The target handed to `_accelerate` while sprinting - a *wish*, not a
     * speed, and deliberately well above the cap above.
     *
     * Kept at 8.2 rather than lowered to the truth because lowering it is not
     * free. `_accelerate` adds `min(acceleration * dt, wish - current)`, so
     * while `current` is between the cap and the wish the two values behave
     * differently: coming down from a parkour leap landing at 8.52 m/s, a wish
     * of 8.2 keeps pushing and the speed decays over about a second, where a
     * wish of 6.0 stops pushing and it collapses in two steps. That is momentum
     * the player can feel, so the constant that names the ceiling was split off
     * instead of being written over the one that sets the feel.
     *
     * ── The option NOT taken, recorded so it stays available ──────────────
     * Sprint could be made genuinely faster instead, by moving the ratio rather
     * than the label: `acceleration: 82` (or `friction: 7.3`) puts the cap at
     * 8.2 and makes the old constant true. That is a real change to how the
     * game feels - it also raises the ceiling every other ground speed is
     * measured against, including the boosted walk - so it is a decision for
     * the owner, not a tidy-up. It was not taken here.
     */
    sprintWishSpeed: 8.2,
    crouchSpeed: 2.2,
    /**
     * With `friction`, this sets the top ground speed outright:
     * `acceleration / friction` = 6.0 m/s. @see sprintSpeed
     */
    acceleration: 60,
    airAcceleration: 12,
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
