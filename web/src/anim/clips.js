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

  // Sample the foot in CHARACTER space across one cycle. Stance is the longest
  // run of low-height samples; its path length is how far one cycle carries the
  // body. Measured rather than assumed, because getting it wrong reintroduces
  // exactly the sliding the clips exist to remove — a 1.0 fallback left the
  // stance foot moving at 2.53 m/s when the true value was 0.643.
  const N = 60;
  const inv = new THREE.Matrix4();
  const w = new THREE.Vector3();
  const pts = [];
  for (let i = 0; i <= N; i++) {
    mixer.setTime((i / N) * clip.duration);
    root.updateWorldMatrix(true, true);
    foot.getWorldPosition(w);
    inv.copy(root.matrixWorld).invert();
    pts.push({ p: w.clone().applyMatrix4(inv), y: w.y });
  }
  action.stop();

  const ys = pts.map((s) => s.y);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  const thr = lo + (hi - lo) * 0.20;
  let best = 0, run = 0;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].y < thr && pts[i - 1].y < thr) run += pts[i].p.distanceTo(pts[i - 1].p);
    else { best = Math.max(best, run); run = 0; }
  }
  best = Math.max(best, run);
  return best > 0.05 ? best : 1.0;
}
