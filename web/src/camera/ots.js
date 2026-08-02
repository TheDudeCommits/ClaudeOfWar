import * as THREE from 'three';

/**
 * Over-the-shoulder combat camera.
 *
 * Framing is the single strongest cue separating a AAA action game from a hobby
 * project: the reference plates sit ~2 m behind the hero's right shoulder at
 * chest height on a wide-ish lens, so the hero eats a third of the frame. A
 * polite, far-back, level third-person camera loses the blind test before
 * lighting is even considered. ART_BIBLE §1.
 */
export class OTSCamera {
  constructor(camera) {
    this.camera = camera;
    this.target = null;
    this.lockOn = null;
    this.enabled = true;

    // Negative X: camera rides the hero's right shoulder, which puts the hero
    // in the LEFT third and leaves the right two-thirds for the enemy — the
    // reference composition. Positive X mirrors it and reads wrong.
    this.shoulder = new THREE.Vector3(-0.62, 1.35, 0);
    this.distance = 2.45;
    this.fovBase = 56;
    this.pitch = THREE.MathUtils.degToRad(-8);
    this.lockHeroBias = 0.68;

    this.followLag = 12;
    this.aimLag = 9;
    this.traumaDecay = 1.9;
    this.maxShakePos = 0.085;
    this.maxShakeRot = 2.1;

    this._trauma = 0;
    this._fovPunch = 0;
    this._pos = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._init = false;
    this._seed = Math.random() * 1000;
    this._tmp = new THREE.Vector3();
  }

  /** Landed hit. amount 0..1. */
  /** `fovDip` is the punch in degrees and is used as given — callers already
   *  scale it by hit power, and multiplying by `amount` again here halved every
   *  punch to ~1.3 deg against the 3-6 deg the art bible asks for. */
  impact(amount, fovDip = -4.5) {
    this._trauma = THREE.MathUtils.clamp(this._trauma + amount, 0, 1);
    this._fovPunch = Math.min(this._fovPunch, fovDip);
  }

  update(dt) {
    if (!this.enabled || !this.target) return;
    const cam = this.camera;

    const basisX = this._tmp.set(1, 0, 0).applyQuaternion(this.target.quaternion);
    const anchor = new THREE.Vector3()
      .copy(this.target.position)
      .addScaledVector(basisX, this.shoulder.x)
      .setY(this.target.position.y + this.shoulder.y);

    let wantAim = anchor.clone();
    if (this.lockOn) {
      // Weight toward the hero so the enemy reads in the right two-thirds
      // rather than both actors sitting dead centre.
      const t = this.lockOn.position.clone().setY(this.lockOn.position.y + 1.1);
      wantAim.lerp(t, 1 - this.lockHeroBias);
    }

    if (!this._init) {
      this._pos.copy(anchor); this._aim.copy(wantAim); this._init = true;
    } else {
      this._pos.lerp(anchor, 1 - Math.exp(-this.followLag * dt));
      this._aim.lerp(wantAim, 1 - Math.exp(-this.aimLag * dt));
    }

    let yaw = 0;
    if (this.lockOn) {
      const f = this.lockOn.position.clone().sub(this._pos);
      f.y = 0;
      if (f.lengthSq() > 0.01) yaw = Math.atan2(f.x, f.z) + Math.PI;
    }

    // `pitch` is negative for "camera looks down", so the camera must sit ABOVE
    // the shoulder anchor and let lookAt tilt it down onto the aim. Using
    // sin(pitch) directly puts it below the anchor and tilts the view upward —
    // which drops the hero's head to the top of frame and reads as a low, weak
    // angle instead of the reference's slightly-above-shoulder framing.
    const rise = Math.sin(-this.pitch);
    const run = Math.cos(this.pitch);
    const dir = new THREE.Vector3(
      Math.sin(yaw) * run,
      rise,
      Math.cos(yaw) * run);
    cam.position.copy(this._pos).addScaledVector(dir, this.distance);

    // Trauma-squared so light hits stay subtle and heavy ones bite.
    this._trauma = Math.max(0, this._trauma - this.traumaDecay * dt);
    const s = this._trauma * this._trauma;
    const t = performance.now() / 1000 * 22 + this._seed;
    const look = this._aim.clone();
    if (s > 1e-4) {
      look.x += (Math.sin(t * 1.31) + Math.sin(t * 2.7)) * 0.5 * this.maxShakePos * s;
      look.y += (Math.sin(t * 1.77) + Math.sin(t * 3.1)) * 0.5 * this.maxShakePos * s;
    }
    cam.lookAt(look);
    cam.rotation.z += THREE.MathUtils.degToRad(
      s > 1e-4 ? Math.sin(t * 1.13) * this.maxShakeRot * s : 0);

    // tau ~45ms: a 9/s decay left a visible 400ms+ tail on every hit.
    this._fovPunch += (0 - this._fovPunch) * (1 - Math.exp(-22 * dt));
    cam.fov = this.fovBase + this._fovPunch;
    cam.updateProjectionMatrix();
  }
}
