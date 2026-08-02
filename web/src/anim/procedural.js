import * as THREE from 'three';

/**
 * Procedural skeletal animation.
 *
 * Both character GLBs ship exactly one clip (`Armature|clip0|baselayer`, an
 * A-pose), so there is no locomotion, attack, hit or death animation to play.
 * Rather than slide the models around as rigid props, this drives the humanoid
 * rig directly: legs swing, knees bend, arms counter-swing, the spine
 * counter-rotates against the hips, and attacks wind up and follow through.
 *
 * Both rigs use identical, conventional bone names, so one implementation
 * covers hero and draugr with only tuning differences.
 */

/**
 * Canonicalise a bone name so one rig class serves several skeletons.
 *
 * Mixamo names carry a `mixamorig` prefix, and the glTF exporter strips the
 * colon, so they arrive as `mixamorigHips` rather than `mixamorig:Hips` —
 * matching on ':' alone finds nothing. Mixamo also numbers the spine
 * Spine/Spine1/Spine2 where this project's generated rig uses
 * Spine/Spine01/Spine02, and capitalises Neck.
 */
export function canonBone(name) {
  let n = String(name);
  n = n.replace(/^mixamorig[:_]?/i, '');
  const i = n.lastIndexOf(':');
  if (i >= 0) n = n.slice(i + 1);
  if (/^Spine([12])$/.test(n)) n = 'Spine0' + n.slice(5);
  if (n === 'Neck') n = 'neck';
  return n;
}

const BONES = [
  'Hips', 'Spine', 'Spine01', 'Spine02', 'neck', 'Head',
  'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand',
  'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand',
  'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase',
  'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase',
];

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _qa = new THREE.Quaternion();
const _fv = new THREE.Vector3();
const _hv = new THREE.Vector3();
const _kv = new THREE.Vector3();
const _wv = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _pq = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _down = new THREE.Vector3(0, -1, 0);
const _right = new THREE.Vector3(1, 0, 0);

export class HumanoidRig {
  constructor(root) {
    this.b = {};
    this.rest = {};
    this.axis = {};      // per-bone pitch/yaw/roll axes, in BONE-LOCAL space
    const canon = canonBone;
    root.traverse((o) => {
      if (!o.isBone) return;
      const c = canon(o.name);
      if (BONES.includes(c) && !this.b[c]) {
        this.b[c] = o;
        this.rest[c] = o.quaternion.clone();
      }
    });
    this.ok = !!(this.b.Hips && this.b.LeftUpLeg && this.b.RightUpLeg);
    this.hipsRestY = this.b.Hips ? this.b.Hips.position.y : 0;
    // Metres -> rig units, derived rather than assumed.
    this.hipUnits = 1;
    if (this.b.Hips) {
      const ws = new THREE.Vector3();
      this.b.Hips.getWorldScale(ws);
      const sc = (ws.x + ws.y + ws.z) / 3;
      if (sc > 1e-6) this.hipUnits = 1 / sc;
    }

    /*
     * Derive each bone's rotation axes from the bind pose.
     *
     * Rotating every bone about its local X and calling that "pitch" assumes
     * the exporter oriented all bones the same way. This rig does not: doing
     * so swung the legs sideways and upward, putting the foot at world Y 1.6 —
     * above the hip. Instead, take the CHARACTER's right/up/forward axes and
     * express them in each bone's local frame, so "swing the leg forward"
     * means the same thing on every bone regardless of its bind orientation.
     */
    root.updateWorldMatrix(true, true);
    const charQ = new THREE.Quaternion();
    root.getWorldQuaternion(charQ);
    const inv = new THREE.Quaternion();
    const bq = new THREE.Quaternion();
    for (const n in this.b) {
      this.b[n].updateWorldMatrix(true, false);
      this.b[n].getWorldQuaternion(bq);
      inv.copy(bq).invert();
      this.axis[n] = {
        pitch: new THREE.Vector3(1, 0, 0).applyQuaternion(charQ).applyQuaternion(inv).normalize(),
        yaw:   new THREE.Vector3(0, 1, 0).applyQuaternion(charQ).applyQuaternion(inv).normalize(),
        roll:  new THREE.Vector3(0, 0, 1).applyQuaternion(charQ).applyQuaternion(inv).normalize(),
      };
    }
  }

  /** Reset every driven bone to bind pose; call once per frame before posing. */
  reset() {
    for (const n in this.b) this.b[n].quaternion.copy(this.rest[n]);
    if (this.b.Hips) this.b.Hips.position.y = this.hipsRestY;
  }

  /** Build a rotation from character-space pitch/yaw/roll for this bone. */
  _delta(name, x, y, z) {
    const a = this.axis[name];
    _q.identity();
    if (x) _q.multiply(_qa.setFromAxisAngle(a.pitch, x));
    if (y) _q.multiply(_qa.setFromAxisAngle(a.yaw, y));
    if (z) _q.multiply(_qa.setFromAxisAngle(a.roll, z));
    return _q;
  }

  /** Rotate a bone by character-space radians relative to its bind pose. */
  rot(name, x, y, z) {
    const bone = this.b[name];
    if (!bone) return;
    bone.quaternion.copy(this.rest[name]).multiply(this._delta(name, x, y, z));
  }

  addRot(name, x, y, z) {
    const bone = this.b[name];
    if (!bone) return;
    bone.quaternion.multiply(this._delta(name, x, y, z));
  }

  hipOffset(dy) {
    // The rig is authored in CENTIMETRES (hipsRestY ~98.7 with a 0.01 world
    // scale), so writing metres here produced 0.55mm of bob against the 55mm
    // requested — i.e. no vertical movement at all.
    if (this.b.Hips) this.b.Hips.position.y = this.hipsRestY + dy * this.hipUnits;
  }
}

/** Shared tuning knobs so the draugr can lurch where the hero strides. */
export const HERO_ANIM = {
  strideFreq: 2.05, strideAmp: 0.78, kneeAmp: 0.95, armAmp: 0.55,
  hipBob: 0.055, hipRoll: 0.09, spineTwist: 0.16, lean: 0.10,
  idleBreath: 0.035, footPlant: 0.35,
};

export const ZOMBIE_ANIM = {
  strideFreq: 1.35, strideAmp: 0.52, kneeAmp: 0.70, armAmp: 0.22,
  hipBob: 0.085, hipRoll: 0.16, spineTwist: 0.07, lean: 0.26,
  idleBreath: 0.05, footPlant: 0.18,
  // Draugr are dragged, not walked: one side leads, the head lolls, the arms
  // hang forward. Symmetry is what makes an undead walk read as a human walk.
  asym: 0.34, headLoll: 0.30, armsForward: 0.85,
};

export class Animator {
  constructor(root, tuning) {
    this.rig = new HumanoidRig(root);
    this.t = tuning;
    this.phase = Math.random() * Math.PI * 2;
    this.hit = 0;
    this.hitDir = 0;
    this._speed = 0;
    // Measured from the bind pose so stride length is derived from the actual
    // rig rather than assumed.
    this.legLength = 0.92;
    if (this.rig.ok && this.rig.b.LeftUpLeg && this.rig.b.LeftFoot) {
      const a = new THREE.Vector3(), b = new THREE.Vector3();
      this.rig.b.LeftUpLeg.getWorldPosition(a);
      this.rig.b.LeftFoot.getWorldPosition(b);
      const l = a.distanceTo(b);
      if (l > 0.2 && l < 2.0) this.legLength = l;
    }
    // Foot lock: world position each foot is pinned to while in stance.
    this._lock = [new THREE.Vector3(), new THREE.Vector3()];
    this._locked = [false, false];
  }

  get ok() { return this.rig.ok; }

  onHit(localDirX) { this.hit = 1; this.hitDir = localDirX; }

  /**
   * @param dt        seconds
   * @param speed     world units/sec of planar motion
   * @param attack    {active, k} where k is 0..1 through the swing, or null
   * @param deadT     0..1 death progress, or 0
   */
  update(dt, speed, attack, deadT) {
    const rig = this.rig, t = this.t;
    if (!rig.ok) return;
    rig.reset();

    this._speed += (speed - this._speed) * (1 - Math.exp(-10 * dt));
    const sp = this._speed;
    const moving = sp > 0.15;

    if (deadT > 0) { this._poseDeath(deadT); return; }

    // Stride frequency must be DERIVED from speed, not merely correlated with
    // it. A foot is only planted if its backward swing exactly cancels the
    // body's forward motion, which requires one full stride per stride-length
    // of ground covered. The previous arbitrary curve left planted feet moving
    // at 3.78 m/s — i.e. skating at body speed, no planting at all.
    //
    //   strideLength ~= 2 * legLength * sin(strideAmp)
    //   steps/sec     = speed / strideLength
    //   phase is one full cycle (two steps) per 2*PI
    const strideLen = Math.max(0.35, 2 * this.legLength * Math.sin(t.strideAmp));
    if (moving) {
      const stepsPerSec = sp / strideLen;
      this.phase += dt * stepsPerSec * Math.PI;   // PI per step, 2PI per cycle
    } else {
      this.phase += dt * 1.1;
    }

    const p = this.phase;
    const gait = moving ? Math.min(1, sp / 3.0) : 0;

    if (moving) this._poseWalk(p, gait);
    else this._poseIdle(p);

    if (attack && attack.active) this._poseAttack(attack.k, attack.combo);

    // Hit reaction is additive on top of whatever the body is already doing —
    // a full-body replacement clip is what makes hits read as canned.
    if (this.hit > 0) {
      this.hit = Math.max(0, this.hit - dt * 4.5);
      const h = this.hit * this.hit;
      rig.addRot('Spine01', -0.30 * h, 0, this.hitDir * 0.34 * h);
      rig.addRot('neck', -0.22 * h, 0, this.hitDir * 0.26 * h);
      rig.addRot('Spine', -0.12 * h, 0, 0);
    }
  }

  _poseWalk(p, gait) {
    const rig = this.rig, t = this.t;
    const a = t.asym ?? 0;
    const s = Math.sin(p), c = Math.cos(p);

    // Legs: thigh swings sinusoidally, knee bends only on the back half of the
    // stride (a knee that bends symmetrically reads as a marionette).
    const swing = t.strideAmp * gait;
    const bendL = Math.max(0, -Math.sin(p)) * t.kneeAmp * gait;
    const bendR = Math.max(0, -Math.sin(p + Math.PI)) * t.kneeAmp * gait;

    rig.rot('LeftUpLeg', s * swing * (1 + a), 0, 0);
    rig.rot('LeftLeg', -bendL, 0, 0);
    rig.rot('LeftFoot', bendL * t.footPlant + s * 0.18 * gait, 0, 0);

    rig.rot('RightUpLeg', -s * swing * (1 - a), 0, 0);
    rig.rot('RightLeg', -bendR, 0, 0);
    rig.rot('RightFoot', bendR * t.footPlant - s * 0.18 * gait, 0, 0);

    // Hips: vertical bob at twice stride frequency, plus a roll onto the
    // planted foot.
    rig.hipOffset(-Math.abs(Math.sin(p)) * t.hipBob * gait);
    rig.rot('Hips', t.lean * gait, s * 0.06 * gait, c * t.hipRoll * gait);

    // Spine counter-rotates against the hips; this is most of what makes a walk
    // look like a body rather than a puppet.
    rig.rot('Spine', -t.lean * 0.5 * gait, -s * t.spineTwist * gait, 0);
    rig.rot('Spine01', 0, -s * t.spineTwist * 0.6 * gait, 0);

    // Arms counter-swing to the opposite leg.
    const arm = t.armAmp * gait;
    const fwd = t.armsForward ?? 0;
    rig.rot('LeftArm', -s * arm - fwd, 0, 0.16 + fwd * 0.25);
    rig.rot('LeftForeArm', -Math.max(0, s) * 0.30 * gait - fwd * 0.9, 0, 0);
    rig.rot('RightArm', s * arm - fwd, 0, -0.16 - fwd * 0.25);
    rig.rot('RightForeArm', -Math.max(0, -s) * 0.30 * gait - fwd * 0.9, 0, 0);

    // Head stabilises against the bob — eyes stay level in real locomotion.
    const loll = t.headLoll ?? 0;
    rig.rot('neck', -t.lean * 0.4 + loll * 0.5, s * 0.05, loll * Math.sin(p * 0.5) * 0.5);
    rig.rot('Head', -c * 0.04 * gait + loll * 0.3, 0, 0);
  }


  _poseIdle(p) {
    const rig = this.rig, t = this.t;
    const br = Math.sin(p * 0.55) * t.idleBreath;
    const sway = Math.sin(p * 0.37) * 0.03;
    rig.hipOffset(br * 0.35);
    rig.rot('Hips', t.lean * 0.35, sway * 0.4, sway);
    rig.rot('Spine', -br * 0.5, -sway * 0.5, 0);
    rig.rot('Spine01', br * 0.8, 0, 0);
    const fwd = t.armsForward ?? 0;
    rig.rot('LeftArm', -0.06 - fwd, 0, 0.20 + fwd * 0.25);
    rig.rot('RightArm', -0.06 - fwd, 0, -0.20 - fwd * 0.25);
    rig.rot('LeftForeArm', -0.14 - fwd * 0.9, 0, 0);
    rig.rot('RightForeArm', -0.14 - fwd * 0.9, 0, 0);
    const loll = t.headLoll ?? 0;
    rig.rot('neck', loll * 0.55, sway * 0.6, loll * 0.4);
  }

  /**
   * k is 0..1 across the whole swing. The shape matters more than the poses:
   * a slow wind-up, a very fast pass through contact, then a longer recovery.
   * Equal spacing reads as a wave, not a strike. ART_BIBLE §11.
   */
  _poseAttack(k, combo = 0) {
    const rig = this.rig;
    const wind = 0.30, strike = 0.16;
    let twist, armSwing, lean;

    if (k < wind) {
      const u = k / wind;                       // ease-out back
      const e = 1 - Math.pow(1 - u, 2);
      twist = -0.55 * e; armSwing = -1.15 * e; lean = -0.16 * e;
    } else if (k < wind + strike) {
      const u = (k - wind) / strike;            // fast pass through
      const e = u * u * (3 - 2 * u);
      twist = -0.55 + 1.45 * e;
      armSwing = -1.15 + 2.55 * e;
      lean = -0.16 + 0.46 * e;
    } else {
      const u = (k - wind - strike) / (1 - wind - strike);
      const e = 1 - Math.pow(1 - u, 3);         // settle back
      twist = 0.90 * (1 - e) + 0.0 * e;
      armSwing = 1.40 * (1 - e);
      lean = 0.30 * (1 - e);
    }

    // The third hit of the combo is an overhead: more vertical, less rotational.
    const overhead = combo === 2 ? 1 : 0;

    rig.addRot('Hips', lean * 0.35, twist * 0.30, 0);
    rig.addRot('Spine', lean * 0.4, twist * 0.42, 0);
    rig.addRot('Spine01', lean * 0.45 + overhead * armSwing * 0.18, twist * 0.34, 0);
    rig.addRot('Spine02', lean * 0.25, twist * 0.20, 0);
    rig.addRot('neck', -lean * 0.35, -twist * 0.22, 0);

    // Right arm carries the weapon.
    rig.addRot('RightShoulder', 0, twist * 0.22, -armSwing * 0.16);
    rig.addRot('RightArm', -armSwing * (0.85 + overhead * 0.5), twist * 0.18,
      -armSwing * 0.22 * (1 - overhead));
    // The -0.25 used to be a constant, which appeared and vanished instantly at
    // the start and end of every attack: a discontinuous 0.25 rad step that
    // spiked weapon-tip speed to 13 m/s for one frame, six times per combo.
    // Enveloped so it fades in and out with the swing.
    const env = Math.min(1, Math.abs(armSwing) * 1.2);
    rig.addRot('RightForeArm', -Math.abs(armSwing) * 0.42 - 0.25 * env, 0, 0);
    // Left arm counterbalances.
    rig.addRot('LeftArm', armSwing * 0.34, twist * 0.10, armSwing * 0.18);
    rig.addRot('LeftForeArm', -Math.abs(armSwing) * 0.30, 0, 0);
  }

  _poseDeath(d) {
    const rig = this.rig;
    const e = 1 - Math.pow(1 - Math.min(1, d), 2);
    rig.hipOffset(-e * 0.32);
    rig.rot('Hips', e * 0.55, 0, e * 0.18);
    rig.rot('Spine', e * 0.42, 0, e * 0.12);
    rig.rot('Spine01', e * 0.38, 0, 0);
    rig.rot('neck', e * 0.55, 0, e * 0.30);
    rig.rot('LeftUpLeg', -e * 0.45, 0, e * 0.20);
    rig.rot('RightUpLeg', -e * 0.30, 0, -e * 0.12);
    rig.rot('LeftLeg', e * 0.70, 0, 0);
    rig.rot('RightLeg', e * 0.45, 0, 0);
    rig.rot('LeftArm', e * 0.55, 0, e * 0.65);
    rig.rot('RightArm', e * 0.45, 0, -e * 0.75);
  }
}
