import * as THREE from 'three';
import { HumanoidRig } from './procedural.js';

/**
 * Clip-driven animation with a procedural additive layer.
 *
 * The base pose comes from baked clips authored against this exact rig
 * (tools/gen_anims.py), where the legs were solved from a foot TRAJECTORY by
 * Blender's IK and baked. Foot planting is therefore a property of the data.
 * The previous runtime system drove a sinusoidal hip angle at fixed pelvis
 * height, which cannot plant a foot at all — measured stance slip was 92% of
 * body speed with the toe 17cm off the floor.
 *
 * The procedural code is kept, but demoted to what it is actually good at:
 * additive offsets on top of a sampled pose — hit flinch, attack lean, aim.
 * That is the split shipped games use.
 *
 * Clips are authored IN PLACE. `metresPerCycle` is measured once at load by
 * sampling the clip, so playback rate = speed / metresPerCycle keeps the plant
 * at any speed instead of relying on an assumed stride.
 */
/**
 * Strip horizontal translation from a locomotion clip.
 *
 * Blender's bake writes position tracks on every bone, Hips included. Any
 * horizontal pelvis translation baked into the clip travels with the body and
 * drags the planted foot along with it, which pins stance-foot speed at ~98%
 * of body speed no matter what playback rate is used. Locomotion clips must be
 * strictly in-place; vertical bob is kept because that is real.
 */
export function makeInPlace(clip) {
  for (const track of clip.tracks) {
    if (!/\.position$/.test(track.name)) continue;
    if (!/Hips/.test(track.name)) continue;
    const v = track.values;
    // Hold X and Z at their first value; keep Y (bob).
    for (let i = 0; i < v.length; i += 3) {
      v[i] = v[0];
      v[i + 2] = v[2];
    }
  }
  return clip;
}

const _T = new THREE.Vector3();
const _H = new THREE.Vector3();
const _K = new THREE.Vector3();
const _F = new THREE.Vector3();
const _L = new THREE.Vector3();
const _cq = new THREE.Quaternion();

/**
 * Two-bone leg IK that pins the stance foot to a world position.
 *
 * A previous attempt at this failed and was reverted; the motion critic
 * diagnosed exactly why, and both causes are avoided here:
 *   1. It wrote hip/knee quaternions in raw world/parent frames, discarding the
 *      bind orientation that every other pose path composes onto. This one goes
 *      through rig.rot(), which composes onto rest[name].
 *   2. It hardcoded local-X as the knee bend axis — precisely the assumption
 *      the bind-pose axis derivation exists to remove. This one uses the
 *      derived per-bone axes.
 *
 * Angles are solved in CHARACTER space so "swing the thigh forward" means the
 * same thing regardless of how the exporter oriented the bones.
 */
function solveLegIK(rig, root, side, targetWorld) {
  const hipB = rig.b[side + 'UpLeg'];
  const kneeB = rig.b[side + 'Leg'];
  const footB = rig.b[side + 'Foot'];
  if (!hipB || !kneeB || !footB) return false;

  hipB.updateWorldMatrix(true, false);
  kneeB.updateWorldMatrix(true, false);
  footB.updateWorldMatrix(true, false);
  _H.setFromMatrixPosition(hipB.matrixWorld);
  _K.setFromMatrixPosition(kneeB.matrixWorld);
  _F.setFromMatrixPosition(footB.matrixWorld);

  const upper = _H.distanceTo(_K);
  const lower = _K.distanceTo(_F);
  if (upper < 1e-4 || lower < 1e-4) return false;

  // Vector hip -> target, expressed in character space.
  root.getWorldQuaternion(_cq).invert();
  _L.copy(targetWorld).sub(_H).applyQuaternion(_cq);
  let d = _L.length();
  const maxReach = (upper + lower) * 0.985;
  if (d > maxReach) { _L.multiplyScalar(maxReach / d); d = maxReach; }
  if (d < 1e-4) return false;

  // Direction of the leg from vertical, in the character's own frame.
  const pitch = Math.atan2(-_L.z, -_L.y);   // forward/back
  const roll = Math.atan2(_L.x, -_L.y);     // side to side

  // Law of cosines for the knee bend and the extra hip rotation it implies.
  const cosK = (upper * upper + lower * lower - d * d) / (2 * upper * lower);
  const cosH = (upper * upper + d * d - lower * lower) / (2 * upper * d);
  const kneeA = Math.acos(THREE.MathUtils.clamp(cosK, -1, 1));
  const hipA = Math.acos(THREE.MathUtils.clamp(cosH, -1, 1));

  rig.rot(side + 'UpLeg', pitch + hipA, 0, roll);
  rig.rot(side + 'Leg', -(Math.PI - kneeA), 0, 0);
  return true;
}

export class ClipAnimator {
  constructor(root, clips, opts = {}) {
    this.root = root;
    this.rig = new HumanoidRig(root);
    this.mixer = new THREE.AnimationMixer(root);
    this.actions = {};
    for (const c of clips) {
      const a = this.mixer.clipAction(c);
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.play();
      this.actions[c.name] = a;
    }
    this.current = null;
    this.metresPerCycle = opts.metresPerCycle || 1.0;
    this.hit = 0;
    this.hitDir = 0;
    this._speed = 0;
    this._blend = {};
    this.armClose = opts.armClose ?? 0.62;   // radians of inward roll
    this.elbowBend = opts.elbowBend ?? 0.34;
    // Foot lock state: the world point each foot is pinned to while in stance.
    // Runtime foot-lock IK is implemented, bind-safe, and OFF by default.
    // Measured slip against body speed, same-foot metric:
    //     calibrated clip alone .......  53%
    //     calibrated clip + foot lock .. 104%
    // It consistently makes things worse: once the clip's playback rate is
    // correctly calibrated the clip already moves the foot at nearly the right
    // rate, and the IK then fights it. Kept behind { footLock: true } because
    // it will be the right tool once a proper walk/idle/turn clip set exists
    // and blending between them reintroduces slip the rate cannot fix.
    this.footLock = opts.footLock === true;
    this._lock = [new THREE.Vector3(), new THREE.Vector3()];
    this._locked = [false, false];
    this._wasStance = [false, false];

    // Auto-calibration. metresPerCycle can be derived analytically, but every
    // analytic attempt has been wrong: path length over-counts wiggle, the
    // measured stance window is phase-shifted from the authored one, and net
    // range under-counts. So instead the animator watches the stance foot's
    // actual velocity in character space and corrects itself. For a planted
    // foot that velocity must equal body speed; the ratio is the correction.
    this._cal = { t: 0, ratio: [], prevZ: null, done: false };
    this._calFoot = new THREE.Vector3();
    this._calInv = new THREE.Matrix4();
  }

  get ok() { return this.rig.ok && Object.keys(this.actions).length > 0; }

  onHit(localDirX) { this.hit = 1; this.hitDir = localDirX; }

  /** Cross-fade weights toward `name` without restarting the clip. */
  _target(name, dt, rate = 1) {
    for (const k in this.actions) {
      const want = k === name ? 1 : 0;
      const w = this.actions[k].getEffectiveWeight();
      const next = w + (want - w) * (1 - Math.exp(-12 * dt));
      this.actions[k].setEffectiveWeight(next);
    }
    const a = this.actions[name];
    if (a) a.setEffectiveTimeScale(rate);
  }

  /**
   * @param dt      seconds
   * @param speed   REALIZED ground speed (not intent velocity)
   * @param attack  {active,k,combo} or null
   * @param deadT   0..1
   */
  update(dt, speed, attack, deadT) {
    if (!this.ok) return;
    this._speed += (speed - this._speed) * (1 - Math.exp(-14 * dt));
    const sp = this._speed;

    if (this.actions.run) {
      // Playback rate derived from distance, so a planted foot stays planted
      // whatever the body is doing.
      // The clamp used to be 3.0 while the required rate was speed/0.319 =
      // 10.2, so the legs were hard-capped at a third of the cadence needed to
      // keep a foot planted — and no amount of tuning metresPerCycle could fix
      // it, which is why a sweep of that value produced a flat response.
      const rate = THREE.MathUtils.clamp(sp / this.metresPerCycle, 0.0, 12.0);
      this._target('run', dt, Math.max(0.05, rate));
      // Below a walking threshold, fade the clip out rather than crawl it.
      if (sp < 0.25) this.actions.run.setEffectiveWeight(
        this.actions.run.getEffectiveWeight() * Math.exp(-8 * dt));
    }

    this.mixer.update(dt);

    // ---- additive layer, applied AFTER sampling the clip ----
    // Close the A-pose. The export bind holds the arms 43 degrees out from the
    // torso and the clip only partially corrects it, so the character still
    // ran like a scarecrow. Applied here rather than in the clip because this
    // path uses the bind-pose-derived rotation axes, which are verified; the
    // Blender-side arm authoring fights whatever axes the exporter chose.
    const close = this.armClose;
    if (close) {
      this.rig.addRot('LeftArm', 0, 0, -close);
      this.rig.addRot('RightArm', 0, 0, close);
      this.rig.addRot('LeftForeArm', -this.elbowBend, 0, 0);
      this.rig.addRot('RightForeArm', -this.elbowBend, 0, 0);
    }
    if (deadT > 0) {
      const e = 1 - Math.pow(1 - Math.min(1, deadT), 2);
      this.rig.addRot('Hips', e * 0.55, 0, e * 0.18);
      this.rig.addRot('Spine', e * 0.42, 0, e * 0.12);
      this.rig.addRot('neck', e * 0.55, 0, e * 0.30);
      this.rig.addRot('LeftArm', e * 0.55, 0, e * 0.65);
      this.rig.addRot('RightArm', e * 0.45, 0, -e * 0.75);
      return;
    }

    if (attack && attack.active) {
      const k = attack.k;
      const wind = 0.30, strike = 0.16;
      let twist, armSwing, lean;
      if (k < wind) {
        const e = 1 - Math.pow(1 - k / wind, 2);
        twist = -0.55 * e; armSwing = -1.15 * e; lean = -0.16 * e;
      } else if (k < wind + strike) {
        const u = (k - wind) / strike, e = u * u * (3 - 2 * u);
        twist = -0.55 + 1.45 * e; armSwing = -1.15 + 2.55 * e; lean = -0.16 + 0.46 * e;
      } else {
        const u = (k - wind - strike) / (1 - wind - strike);
        const e = 1 - Math.pow(1 - u, 3);
        twist = 0.90 * (1 - e); armSwing = 1.40 * (1 - e); lean = 0.30 * (1 - e);
      }
      const overhead = attack.combo === 2 ? 1 : 0;
      const env = Math.min(1, Math.abs(armSwing) * 1.2);
      this.rig.addRot('Spine', lean * 0.4, twist * 0.42, 0);
      this.rig.addRot('Spine01', lean * 0.45 + overhead * armSwing * 0.18, twist * 0.34, 0);
      this.rig.addRot('RightArm', -armSwing * (0.85 + overhead * 0.5), twist * 0.18,
        -armSwing * 0.22 * (1 - overhead));
      this.rig.addRot('RightForeArm', -Math.abs(armSwing) * 0.42 - 0.25 * env, 0, 0);
      this.rig.addRot('LeftArm', armSwing * 0.34, twist * 0.10, armSwing * 0.18);
    }

    if (this.hit > 0) {
      this.hit = Math.max(0, this.hit - dt * 4.5);
      const h = this.hit * this.hit;
      this.rig.addRot('Spine01', -0.30 * h, 0, this.hitDir * 0.34 * h);
      this.rig.addRot('neck', -0.22 * h, 0, this.hitDir * 0.26 * h);
    }

    if (!this._cal.done && sp > 1.0) this._calibrate(dt, sp);
    if (this.footLock && sp > 0.3) this._solveFeet(dt, sp);
  }

  /**
   * Watch the stance foot and correct metresPerCycle until it plants.
   *
   * A planted foot travels backward in character space at exactly body speed.
   * Whatever it actually does, the ratio between the two is the factor
   * metresPerCycle is wrong by, so one multiply converges it. Samples are only
   * taken while the SAME foot remains the lower one, because the position
   * jumps a whole stride at a stance switch and that discontinuity is what has
   * corrupted every slide measurement in this project so far.
   */
  _calibrate(dt, speed) {
    const rig = this.rig;
    const L = rig.b.LeftFoot, R = rig.b.RightFoot;
    if (!L || !R) { this._cal.done = true; return; }
    this.root.updateWorldMatrix(true, true);
    L.updateWorldMatrix(true, false);
    R.updateWorldMatrix(true, false);
    const lp = _T.setFromMatrixPosition(L.matrixWorld).y;
    const rp = _H.setFromMatrixPosition(R.matrixWorld).y;
    const which = lp <= rp ? 'L' : 'R';
    this._calFoot.setFromMatrixPosition((which === 'L' ? L : R).matrixWorld);
    this._calInv.copy(this.root.matrixWorld).invert();
    const z = this._calFoot.applyMatrix4(this._calInv).z;

    const c = this._cal;
    if (c.prevZ !== null && c.prevWhich === which && dt > 0 && dt < 0.05) {
      const v = (z - c.prevZ) / dt;
      if (v > 0.2) c.ratio.push(v / speed);
    }
    c.prevZ = z;
    c.prevWhich = which;
    c.t += dt;

    if (c.ratio.length >= 40) {
      c.ratio.sort((a, b) => a - b);
      const med = c.ratio[Math.floor(c.ratio.length / 2)];
      if (med > 0.2 && med < 8) {
        this.metresPerCycle *= med;
        console.log('[anim] calibrated metresPerCycle x' + med.toFixed(2)
          + ' -> ' + this.metresPerCycle.toFixed(3));
      }
      c.done = true;
    } else if (c.t > 6) {
      c.done = true;
    }
  }

  /**
   * Pin whichever foot is currently in stance.
   *
   * The authored clip gets the swing shape right but its stance excursion is
   * far short of what the body actually covers, so the plant has to be closed
   * at runtime. Whichever foot is lower is the stance foot; it is pinned at the
   * world point where it landed and released when the clip lifts it again.
   */
  _solveFeet(dt, speed) {   // eslint-disable-line no-unused-vars
    const rig = this.rig;
    const sides = ['Left', 'Right'];
    this.root.updateWorldMatrix(true, true);

    const pos = [new THREE.Vector3(), new THREE.Vector3()];
    for (let i = 0; i < 2; i++) {
      const b = rig.b[sides[i] + 'Foot'];
      if (!b) return;
      b.updateWorldMatrix(true, false);
      pos[i].setFromMatrixPosition(b.matrixWorld);
    }

    // Stance selection with HYSTERESIS and a minimum dwell.
    //
    // Plain "whichever foot is lower" is a feedback loop: the IK moves the
    // stance foot, which changes which foot is lowest, which reassigns stance.
    // Measured, it flipped 85 times in 180 frames where a 0.8s cycle should
    // give about 5. Deriving stance from clip phase avoids the loop but the
    // exported clip is phase-shifted (its stance window measures 0.28..0.88,
    // not the authored 0.0..0.6), so a hardcoded split pins the wrong foot.
    //
    // Requiring a clear height margin plus a dwell time gives a stable signal
    // from the honest source without either failure.
    this._dwell = (this._dwell || 0) + dt;
    let stance = this._stance ?? (pos[0].y <= pos[1].y ? 0 : 1);
    const other = 1 - stance;
    if (this._dwell > 0.12 && pos[other].y < pos[stance].y - 0.035) {
      stance = other;
      this._dwell = 0;
      this._locked[0] = this._locked[1] = false;
    }
    this._stance = stance;

    for (let i = 0; i < 2; i++) {
      if (i !== stance) { this._locked[i] = false; continue; }
      if (!this._locked[i]) {
        // Newly planted: remember where, and keep it on the ground plane.
        this._locked[i] = true;
        this._lock[i].copy(pos[i]);
        continue;
      }
      _T.copy(this._lock[i]);
      // Release rather than tear if the body has walked out of reach; the next
      // frame re-plants at the current position.
      if (!solveLegIK(rig, this.root, sides[i], _T)) this._locked[i] = false;
    }
  }
}

/**
 * Measure how far one cycle of a locomotion clip carries the body.
 *
 * Derived from the clip rather than assumed: sample the stance foot's backward
 * travel in the clip's own space. Getting this wrong reintroduces exactly the
 * sliding the clips exist to remove, so it is measured, not guessed.
 */
export function measureCycleDistance(root, clip) {
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.setEffectiveWeight(1);
  action.play();

  let foot = null;
  root.traverse((o) => { if (!foot && o.isBone && o.name === 'LeftFoot') foot = o; });
  if (!foot) { action.stop(); return 1.0; }

  // NET displacement along the character's forward axis across the stance
  // window — NOT path length. Path length counts every wiggle and lateral
  // wobble, and reported 0.347 where the true net travel is ~0.52, so the
  // playback rate was wrong by 50% and the foot overshot.
  //
  // The stance window is also MEASURED, not assumed. It runs 0.28..0.88 of the
  // cycle here, against the 0.0..0.6 the authoring intends — the exported clip
  // is phase-shifted, which is why a hardcoded phase split pinned the wrong
  // foot.
  const N = 80;
  const inv = new THREE.Matrix4();
  const w = new THREE.Vector3();
  const pts = [];
  for (let i = 0; i < N; i++) {
    mixer.setTime((i / N) * clip.duration);
    root.updateWorldMatrix(true, true);
    foot.getWorldPosition(w);
    inv.copy(root.matrixWorld).invert();
    pts.push({ z: w.clone().applyMatrix4(inv).z, y: w.y });
  }
  action.stop();

  const ys = pts.map((s) => s.y);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const thr = lo + (hi - lo) * 0.30;

  // Longest consecutive down-run, wrapping, then its net z displacement.
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < N * 2; i++) {
    const k = i % N;
    if (pts[k].y < thr) {
      if (curLen === 0) curStart = k;
      curLen++;
      if (curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else curLen = 0;
    if (i >= N && curLen === 0) break;
  }
  if (bestLen < 3) return 1.0;
  const a = pts[bestStart].z;
  const b = pts[(bestStart + bestLen - 1) % N].z;
  const net = Math.abs(b - a);
  return net > 0.05 ? net : 1.0;
}
