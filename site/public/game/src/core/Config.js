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
    sprintSpeed: 8.2,
    crouchSpeed: 2.2,
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
