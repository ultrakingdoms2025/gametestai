import * as THREE from 'three';
import { TENNIS_GAME_ID, TUNING } from './TennisMatch.js';

/**
 * The player's one-shot forehand.
 *
 * A fifth late-pose module, and the same shape as the fourth: no clips, no
 * mixer - a function that writes bone rotations after `PlayerAvatar.update()`
 * has rewritten every bone, because anything written earlier in the frame is
 * silently thrown away (see Player._installLatePose). It joins the pass from
 * main.js AFTER MinigamePose - the integration spec wraps the two in one
 * `applyPose` - so during the half-second it has weight, the swing is the
 * final word over the generic countdown/finish poses.
 *
 * It fires off `TennisMatch.playerSwingAge`, which the match sets on the swing
 * key and on the automatic serve, so pose and rally can never disagree about
 * whether a stroke happened. Between swings this is two null checks.
 *
 * The weight envelope is a feathered sine - zero at both ends - so the stroke
 * blends out of whatever the avatar was doing and hands back without a snap;
 * one-shot poses that slerp at full weight from frame one are what make an
 * avatar twitch.
 */

const _q = new THREE.Quaternion();
const _e = new THREE.Euler();

export class TennisPose {
  /**
   * @param {{ player:any, minigames:import('./MinigameManager.js').MinigameManager }} ctx
   */
  constructor({ player, minigames }) {
    this.player = player ?? null;
    this.minigames = minigames ?? null;
  }

  /**
   * @param {number} dt
   * @param {number} elapsed
   */
  applyPose(dt, elapsed) {
    const g = this.minigames?._game;
    const humanoid = this.player?.avatar?.humanoid;
    if (!humanoid || !g || g.id !== TENNIS_GAME_ID) return;
    const age = g.playerSwingAge;
    if (!(age >= 0) || age >= TUNING.SWING_S) return;

    const t = age / TUNING.SWING_S;
    const w = Math.pow(Math.sin(Math.PI * t), 0.65);
    // -1 at full wind-up, +1 at full follow-through. The wind-up takes the
    // first third of the stroke, which is what reads as a hit and not a wave.
    const s = t < 0.32 ? -(t / 0.32) : -1 + ((t - 0.32) / 0.68) * 2;

    const B = humanoid.bones;
    const set = (name, x, y, z, weight = w) => {
      const bone = B.get(name);
      if (!bone) return;
      _e.set(x, y, z);
      _q.setFromEuler(_e);
      bone.quaternion.slerp(_q, weight);
    };

    // Racket arm: swept back and high, then flat across the chest.
    set('clavicleR', 0, 0, -0.18 - 0.1 * s);
    set('upperArmR', 0.85 + 1.05 * s, 0, 0.6 - 0.3 * s);
    set('foreArmR', 0.7 - 0.45 * Math.max(0, s), 0, 0.12);
    set('handR', 0.12, 0, -0.15 * s);
    // Off arm balances the stroke instead of hanging.
    set('upperArmL', 0.35 - 0.25 * s, 0, -0.35);
    set('foreArmL', 0.45, 0, -0.08);
    // Hips lead, shoulders follow: the torso Y-twist is what sells the stroke.
    set('spine01', 0.04, -0.16 * s, 0);
    set('spine02', 0.05, -0.24 * s, 0);
    set('spine03', 0.05, -0.2 * s, 0);
    set('neck', -0.06, 0.18 * s, 0);
    set('head', -0.08, 0.22 * s, 0);
    void dt;
    void elapsed;
  }
}

export default TennisPose;
