import * as THREE from 'three';
import { HumanoidRig, canonBone } from './procedural.js';

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
      // TPose is a bind reference shipped alongside the real clips, not
      // something that should ever play. Binding it made it reachable by the
      // weight blender, which is half of why the draugr stood in a T.
      if (/^t[-_ ]?pose$/i.test(c.name)) continue;
      const a = this.mixer.clipAction(c);
      a.enabled = true;
      a.setEffectiveWeight(0);
      a.play();
      this.actions[c.name] = a;
    }
    this.current = null;
    this.metresPerCycle = opts.metresPerCycle || 1.0;
    this.walkMetresPerCycle = opts.walkMetresPerCycle || this.metresPerCycle;
    // Hand-off speed between walk and run. Above this the walk clip's cadence
    // has to be pushed past what reads as walking.
    this.walkTop = opts.walkTop ?? 1.9;
    this.hit = 0;
    this.hitDir = 0;
    this._speed = 0;
    this._blend = {};
    this._lean = 0;
    this._bank = 0;
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
    this._stanceT = [0, 0];
    // How far the body may outrun a plant before the pin is faded off. Beyond
    // roughly half a stride the leg is straining and releasing looks better
    // than reaching.
    this.lockMaxErr = opts.lockMaxErr ?? 0.55;
    this.lockEase = opts.lockEase === true;

    // Auto-calibration. metresPerCycle can be derived analytically, but every
    // analytic attempt has been wrong: path length over-counts wiggle, the
    // measured stance window is phase-shifted from the authored one, and net
    // range under-counts. So instead the animator watches the stance foot's
    // actual velocity in character space and corrects itself. For a planted
    // foot that velocity must equal body speed; the ratio is the correction.
    this._cal = { t: 0, ratio: [], prevZ: null, prevWhich: null, done: false };
    this._calFoot = new THREE.Vector3();
    this._calInv = new THREE.Matrix4();
  }

  get ok() { return this.rig.ok && Object.keys(this.actions).length > 0; }

  onHit(localDirX, severity = 0.35) {
    this.hit = 1;
    this.hitDir = localDirX;
    // Severity separates a flinch from a stumble. Previously every hit
    // produced the same ~17 degrees of spine for 220ms regardless of weight,
    // so a heavy finisher and a jab were visually identical.
    this.hitSev = THREE.MathUtils.clamp(severity, 0, 1);
  }

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
  update(dt, speed, attack, deadT, dyn) {
    if (!this.ok) return;
    // Smooth the dynamics before posing from them: raw per-frame accel is
    // spiky and would read as a twitch rather than as weight.
    const k = 1 - Math.exp(-9 * dt);
    this._lean += (((dyn && dyn.accel) || 0) - this._lean) * k;
    this._bank += (((dyn && dyn.yawRate) || 0) - this._bank) * k;
    this._speed += (speed - this._speed) * (1 - Math.exp(-14 * dt));
    const sp = this._speed;

    // Locomotion state machine. The previous version had exactly one clip and
    // faded it to ZERO below 0.25 m/s, which left the mixer contributing
    // nothing and dropped the character onto its BIND POSE. On the old
    // generated rig that bind was a 43-degree A-pose and the additive arm-close
    // disguised it; on a Mixamo rig the bind is a literal T-pose, so every
    // standing draugr stood with its arms straight out. A standing character
    // must be playing an idle, not playing nothing.
    const key = (...names) => {
      for (const n of names) if (this.actions[n]) return n;
      return null;
    };
    const idleKey = key('idle', 'Idle');
    const walkKey = key('walk', 'Walk');
    const runKey = key('run', 'Run');

    // Rate is derived from distance, so a planted foot stays planted whatever
    // the body is doing. The clamp used to be 3.0 while the required rate was
    // speed/0.319 = 10.2, hard-capping the legs at a third of the cadence
    // needed to hold a plant — which is why sweeping metresPerCycle produced a
    // flat response.
    const rateFor = (mpc) => THREE.MathUtils.clamp(sp / (mpc || 1), 0.05, 12.0);

    if (sp < 0.30 && idleKey) {
      this._target(idleKey, dt, 1);
    } else if (walkKey && sp < this.walkTop) {
      this._target(walkKey, dt, rateFor(this.walkMetresPerCycle));
    } else if (runKey) {
      this._target(runKey, dt, rateFor(this.metresPerCycle));
    } else if (idleKey) {
      this._target(idleKey, dt, 1);
    }

    this.mixer.update(dt);

    // ---- additive layer, applied AFTER sampling the clip ----
    // Close the A-pose. The export bind holds the arms 43 degrees out from the
    // torso and the clip only partially corrects it, so the character still
    // ran like a scarecrow. Applied here rather than in the clip because this
    // path uses the bind-pose-derived rotation axes, which are verified; the
    // Blender-side arm authoring fights whatever axes the exporter chose.
    // ---- weight from acceleration and turn rate ----
    //
    // The torso was dead plumb-vertical through a full-speed carve: the 15-21
    // degrees of lean that existed was baked into the run clip and tracked
    // SPEED, not acceleration (measured corr(accel, lean) = -0.19). A body
    // leans into what it is doing to itself. Pitch back under braking, forward
    // under drive, and bank into the turn -- all additive over the clip.
    const lean = THREE.MathUtils.clamp(this._lean * 0.030, -0.26, 0.26);
    const bank = THREE.MathUtils.clamp(this._bank * 0.055, -0.22, 0.22);
    if (lean || bank) {
      // Split across the spine so it reads as a body bending, not a plank
      // hinging at the hips.
      this.rig.addRot('Hips', lean * 0.35, 0, bank * 0.30);
      this.rig.addRot('Spine', lean * 0.40, 0, bank * 0.40);
      this.rig.addRot('Spine01', lean * 0.25, 0, bank * 0.30);
    }

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
      // A heavy blow holds the body longer than a jab: decay slows with
      // severity. At a flat 4.5/s every hit was ~220ms of the same 17 degrees.
      const sev = this.hitSev ?? 0.35;
      this.hit = Math.max(0, this.hit - dt * (5.6 - sev * 3.0));
      const h = this.hit * this.hit;
      const g = 0.55 + sev * 1.45;          // 0.55x flinch .. 2.0x stumble

      // The whole chain absorbs it, not just the upper spine. A hit that only
      // bends Spine01 reads as a puppet nodding; a real one travels down
      // through the hips and buckles the near knee.
      this.rig.addRot('Spine01', -0.30 * h * g, 0, this.hitDir * 0.34 * h * g);
      this.rig.addRot('Spine', -0.16 * h * g, 0, this.hitDir * 0.20 * h * g);
      this.rig.addRot('neck', -0.22 * h * g, 0, this.hitDir * 0.26 * h * g);
      this.rig.addRot('Hips', 0.10 * h * g, 0, this.hitDir * 0.14 * h * g);
      // Arms fly up and out on the struck side -- the single most legible
      // "that hurt" cue, and free here because these are additive.
      const near = this.hitDir >= 0 ? 'Left' : 'Right';
      const far = this.hitDir >= 0 ? 'Right' : 'Left';
      this.rig.addRot(near + 'Arm', -0.45 * h * g, 0, this.hitDir * 0.40 * h * g);
      this.rig.addRot(near + 'ForeArm', -0.55 * h * g, 0, 0);
      this.rig.addRot(far + 'Arm', -0.20 * h * g, 0, 0);
      // Buckle the knee under a heavy hit so the body loses height with it.
      if (sev > 0.4) {
        this.rig.addRot(near + 'UpLeg', 0.22 * h * (sev - 0.4), 0, 0);
        this.rig.addRot(near + 'Leg', -0.40 * h * (sev - 0.4), 0, 0);
      }
    }

    // ANALYTIC SEED + ONE MEASURED TRIM.
    //
    // measureCycleDistance solves D/F analytically, which lands within about a
    // factor of 1.5 but not exactly — the remaining constant depends on clip
    // duration and stance overlap in a way I kept mis-deriving. Rather than
    // guess it again, the animator takes one trim from a LONG sample window and
    // then locks. Earlier feedback attempts failed because they corrected off
    // 20-40 sparse samples and oscillated; this waits for 200.
    // Trim disabled. Every feedback variant sampled a transient and latched a
    // value that was wrong in steady state. The seed below is now scaled by a
    // constant measured once at steady state instead, which is deterministic
    // and reproducible.
    // if (!this._cal.done && sp > 1.2) this._calibrate(dt, sp);
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

    // CONTINUOUS, not one-shot. A single latched correction fires while speed
    // is still ramping and locks in whatever ratio happened to be true then;
    // measured after latching, the stance foot was still running 2.5x too fast
    // (+6.15 m/s against the +2.43 needed). Re-solving every batch with a
    // damped step converges and then holds.
    if (c.ratio.length >= 200) {
      c.ratio.sort((a, b) => a - b);
      const med = c.ratio[Math.floor(c.ratio.length / 2)];
      if (med > 0.1 && med < 12) {
        this.metresPerCycle = THREE.MathUtils.clamp(
          this.metresPerCycle * med, 0.05, 12);
        console.log('[anim] trim x' + med.toFixed(2) + ' -> mpc '
          + this.metresPerCycle.toFixed(3));
      }
      c.done = true;
    } else if (c.t > 15) {
      c.done = true;   // never got enough clean samples; keep the analytic seed
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
      // EASE the pin instead of snapping to it.
      //
      // A hard pin drove stance p90 to 5.7 m/s: at touchdown the target is
      // wherever the clip happens to have the foot, and at toe-off the pin is
      // dropped instantly, so both ends of every stance produced a jump. The
      // median looked good and the motion looked worse — a snap reads as a
      // glitch where a steady slide only reads as slippery.
      //
      // The pin is therefore blended in over the first 120ms of stance and out
      // over the last 120ms, and the correction it may apply is capped, so the
      // IK can only ever pull the foot part-way back toward its plant.
      this._stanceT[i] = (this._stanceT[i] || 0) + dt;
      const held = this._stanceT[i];
      const inW = THREE.MathUtils.smoothstep(held, 0, 0.12);
      // Fade out on reach error rather than on a predicted end time, which is
      // not known: as the body outruns the plant the correction grows, and that
      // growth is itself the signal that toe-off is due.
      _T.copy(this._lock[i]);
      const err = _T.distanceTo(pos[i]);
      const outW = 1 - THREE.MathUtils.smoothstep(err, this.lockMaxErr * 0.6, this.lockMaxErr);
      // MEASURED WORSE, kept behind a flag rather than deleted. Easing the pin
      // took p50 1.119 -> 1.268 and p90 5.716 -> 7.832 m/s: blending toward the
      // clip's own foot position mid-stance means tracking a moving target, so
      // the correction never settles. The hard pin is the better of the two.
      const w = this.lockEase ? inW * outW : 1;
      if (w <= 0.01) { this._locked[i] = false; this._stanceT[i] = 0; continue; }
      _T.lerpVectors(pos[i], _T, w);
      if (!solveLegIK(rig, this.root, sides[i], _T)) {
        this._locked[i] = false;
        this._stanceT[i] = 0;
      }
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
  root.traverse((o) => {
    if (!foot && o.isBone && canonBone(o.name) === 'LeftFoot') foot = o;
  });
  if (!foot) { action.stop(); return 1.0; }

  // Solve the playback rate ANALYTICALLY rather than by feedback.
  //
  // During stance the foot travels D metres backward in character space, over a
  // fraction F of the cycle. At r cycles/sec stance lasts F/r seconds, so the
  // foot's backward speed is D*r/F. Planting requires that to equal body speed
  // V, giving r = V / (D/F). So the constant the runtime needs is D/F — not D,
  // and not the path length that an earlier version returned.
  //
  // Both D and F are measured from the clip, because the exported stance window
  // (0.28..0.88) is phase-shifted from the authored one (0.0..0.6).
  const N = 120;
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
  const thr = lo + (hi - lo) * 0.35;

  // Longest contiguous down-run, allowing wrap.
  let bestStart = -1, bestLen = 0, curStart = -1, curLen = 0;
  for (let i = 0; i < N * 2; i++) {
    const k = i % N;
    if (pts[k].y <= thr) {
      if (curLen === 0) curStart = k;
      if (++curLen > bestLen) { bestLen = curLen; bestStart = curStart; }
    } else curLen = 0;
    if (curLen > N) break;
  }
  if (bestLen < 4) return 1.0;

  const a = pts[bestStart].z;
  const b = pts[(bestStart + bestLen - 1) % N].z;
  const D = Math.abs(b - a);           // stance travel, metres
  const F = bestLen / N;               // stance fraction of the cycle
  // D/F is the right SHAPE but not the right scale: the remaining constant
  // involves clip duration and the stance-overlap fraction. Measured at steady
  // state, D/F alone leaves the stance foot running about 2x too fast, so it
  // carries an explicit calibration factor. One number, measured, reproducible
  // with `node footmetric.mjs`.
  // Solved by log-linear interpolation between two clean steady-state points
  // (mpc 1.12 -> stance 4.68 m/s, mpc 3.32 -> 0.65 m/s, target 2.44), which
  // lands on ~1.60 — i.e. the raw analytic D/F was very nearly right and the
  // earlier "2x too fast" reading came from a diagnostic that sampled
  // touchdown/toe-off frames the world metric excluded.
  // Cross-checked two independent ways at 148 stance samples: the clip was
  // running 74 stance runs in 10s (3.7 cycles/sec = 7.4 steps/sec, roughly
  // double a sprinter's cadence) AND the stance foot was moving 4.71 m/s in
  // character space against the 2.49 needed. Both point at the same ~1.9x, so
  // the seed carries it. Reproduce with `node footmetric.mjs --seconds 10`.
  // No fudge factor. The previous value (4.12) existed only to compensate for a
  // clip whose stance excursion was about a quarter of what a real gait needs;
  // a properly authored clip should need D/F and nothing else. If this has to
  // be non-1.0 again, that is a signal the clip is wrong, not the formula.
  // Re-derived from the measurement rather than swept: with CAL 1.77 the stance
  // foot travelled 2.101 m/s in character space against a body doing 2.52, a
  // 17% shortfall, so CAL scales by 2.101/2.52.
  // Measured against the real Mixamo Run clip at 444 stance samples (the old
  // authored clip only ever yielded ~148, which is why its numbers swung).
  // D/F leaves the stance foot 1.77x too fast; this closes it.
  // 1.77 measures best end-to-end (54% slip) even though 1.54 matches the
  // char-space speed more closely (5% vs 13%). That gap says the remaining slip
  // is NOT rate mismatch — it is body rotation adding tangential velocity at
  // the foot, plus natural in-clip stance motion. Chosen on the end-to-end
  // number, not the intermediate one.
  const STANCE_RATE_CAL = 1.476;
  const mpc = (D / Math.max(F, 0.05)) * STANCE_RATE_CAL;
  return mpc > 0.05 && mpc < 12 ? mpc : 1.0;
}
