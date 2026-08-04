import * as THREE from 'three';
import { Animator, HERO_ANIM, ZOMBIE_ANIM } from '../anim/procedural.js';

/**
 * Player control, melee combat and enemy AI.
 *
 * The character GLBs ship with a single (A-pose) clip each, so there is no
 * locomotion, attack, hit or death animation to play. `anim/procedural.js`
 * drives the humanoid rig directly instead; this file owns state and timing and
 * hands that animator a speed, an attack phase and a death progress.
 */

// Turn rates. Falling with speed is what separates a body from a turret.
const YAW_RATE_REST = 7.3;      // rad/s  (~420 deg/s) standing
const YAW_RATE_SPRINT = 2.8;    // rad/s  (~160 deg/s) at top speed
const PIVOT_ANGLE = 1.92;       // rad, ~110 deg of demanded turn
const PIVOT_MIN_SPEED = 1.8;    // m/s below which a turn is just a turn
const PIVOT_TIME = 0.26;        // s
const PIVOT_YAW_BOOST = 1.9;    // the hips DO come round fast, once planted
const PIVOT_BRAKE = 16.0;       // m/s^2 -- a pivot dumps speed
const ACCEL = 8.0;              // m/s^2 -> ~0.35s to top speed
const DECEL = 12.0;             // m/s^2 on release
const LATERAL_GRIP = 5.0;       // 1/s; low on purpose, so turns scrub speed

/** Shortest signed angle into (-pi, pi]. */
function wrapPi(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

const UP = new THREE.Vector3(0, 1, 0);

// Scratch vectors. The critic measured real combat at ~29ms/frame with only
// ~2.6ms of that on the GPU, plus 200-790ms stalls — i.e. the game was
// CPU-bound and GC-bound, not fill-rate bound. Per-enemy-per-frame Vector3
// allocation in these hot paths was the source; everything below reuses.
const _fwd = new THREE.Vector3();
const _lat = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _zero = new THREE.Vector3();
// hurt() is called from inside loops that are themselves holding _v1.._v4, so
// it must not share them: Player.swing keeps its facing vector in _v1 across
// the enemy loop, and the first hit would otherwise corrupt the facing test
// for every enemy after it.
const _hurtV = new THREE.Vector3();
const _knockV = new THREE.Vector3();
// Ground friction while staggered. Low on purpose: the shove has to carry far
// enough to be read as force and to buy the player recovery time.
const STAGGER_FRICTION = 2.6;
const ARENA_R = 9.0;   // keep actors inside the dressed floor

/* ------------------------------- input ------------------------------- */

export class Input {
  constructor(dom) {
    this.keys = new Set();
    this.attack = false;
    this.dodge = false;
    this.block = false;
    this._onKey = (e, down) => {
      const k = e.code;
      if (down) this.keys.add(k); else this.keys.delete(k);
      if (['Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'ShiftLeft'].includes(k)) e.preventDefault();
      if (down && k === 'Space') this.dodge = true;
    };
    addEventListener('keydown', (e) => this._onKey(e, true));
    addEventListener('keyup', (e) => this._onKey(e, false));
    dom.addEventListener('mousedown', (e) => {
      if (e.button === 0) this.attack = true;
      if (e.button === 2) this.block = true;
    });
    dom.addEventListener('mouseup', (e) => { if (e.button === 2) this.block = false; });
    dom.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  move() {
    const v = new THREE.Vector2(
      (this.keys.has('KeyD') ? 1 : 0) - (this.keys.has('KeyA') ? 1 : 0),
      (this.keys.has('KeyS') ? 1 : 0) - (this.keys.has('KeyW') ? 1 : 0));
    return v.lengthSq() > 1 ? v.normalize() : v;
  }
  consumeAttack() { const a = this.attack; this.attack = false; return a; }
  consumeDodge() { const d = this.dodge; this.dodge = false; return d; }
}

/* ------------------------------- actors ------------------------------ */

export class Actor {
  constructor(root, opts = {}) {
    this.root = root;
    this.hp = opts.hp ?? 100;
    this.maxHp = this.hp;
    this.speed = opts.speed ?? 3.2;
    // Rotational/linear inertia state. `face` is now what the body IS doing;
    // `faceTarget` is what the input asked for. They are not the same thing.
    this.faceTarget = this.face || 0;
    this.pivotT = 0;
    this.yawRate = 0;
    this.accel = 0;
    this.radius = opts.radius ?? 0.42;
    this.mass = opts.mass ?? 1.0;
    this.dead = false;
    this.vel = new THREE.Vector3();
    this.face = 0;              // yaw
    this._recoil = new THREE.Vector3();
    this._deathT = 0;
    this._flash = 0;
    this._baseY = root.position.y;
  }

  /**
   * @param impulse metres/sec of knockback along `fromDir`. Weight matters:
   *   the same blow shoves a light draugr further than a heavy one, which is
   *   most of what communicates that the fighters have different mass.
   */
  hurt(amount, fromDir, impulse = 0) {
    if (this.dead) return false;
    this.hp -= amount;
    this._flash = 1;
    if (impulse > 0) {
      const dir = _knockV.copy(fromDir).setY(0).normalize();
      this.vel.addScaledVector(dir, impulse / (this.mass ?? 1));
    }
    // Severity drives EVERYTHING downstream: stun length, recoil depth and
    // whether this reads as a flinch or a stumble. Derived from the impulse the
    // blow actually carried relative to this body's mass, so a heavy fighter
    // shrugs off what folds a light one.
    const sev = THREE.MathUtils.clamp(impulse / (this.mass ?? 1) / 4.0, 0, 1);
    if (this.anim) {
      const local = _hurtV.copy(fromDir).setY(0).normalize()
        .applyAxisAngle(UP, -this.root.rotation.y);
      this.anim.onHit(THREE.MathUtils.clamp(local.x, -1, 1), sev);
    }
    this.hitSeverity = Math.max(this.hitSeverity || 0, sev);
    // Stagger was previously assigned by the CALLER, so only the player's own
    // swing produced one and every other damage source was silent.
    this.stagger = Math.max(this.stagger || 0, 0.22 + sev * 0.55);
    // A staggered body cannot be mid-swing. Without this the target stayed in
    // estate:"attack" all the way through being hit and the swing landed
    // anyway, which is why hits had no defensive value.
    // Only a blow with real weight interrupts a swing. Cancelling on every
    // scratch would make the player's combo unusable the moment two draugr are
    // in range, and chip damage should not buy the pack a free interrupt.
    if (this.state === 'attack' && sev > 0.25) { this.state = 'stagger'; this.t = 0; }
    this._releaseToken = true;
    // Directional additive recoil rather than a canned reaction clip.
    this._recoil.copy(fromDir).setY(0).normalize().multiplyScalar(0.22 + sev * 0.45);
    if (this.hp <= 0) { this.dead = true; this._deathT = 0; }
    return true;
  }

  updateCommon(dt) {
    this._flash = Math.max(0, this._flash - dt * 5);
    this.hitSeverity = Math.max(0, (this.hitSeverity || 0) - dt * 1.6);
    this._recoil.multiplyScalar(Math.exp(-12 * dt));
    if (this.dead) {
      this._deathT = Math.min(1, this._deathT + dt * 1.6);
      // Corpses must keep integrating velocity, or a killing blow's knockback
      // is silently discarded. The finisher's 9.5 m/s launch measured 0.0cm of
      // displacement because `update` returned before this ran.
      this.root.position.addScaledVector(this.vel, dt);
      this.vel.multiplyScalar(Math.exp(-4.5 * dt));
      this.clampToArena();
      const fall = 1 - Math.pow(1 - this._deathT, 3);
      this.root.position.y = this._baseY - fall * 0.06;
      // And the death pose has to be driven, or the corpse freezes upright in
      // whatever walk frame it died on.
      this.anim?.update(dt, 0, null, this._deathT);
    }
  }

  clampToArena() {
    const p = this.root.position;
    const d = Math.hypot(p.x, p.z);
    if (d > ARENA_R) { p.x *= ARENA_R / d; p.z *= ARENA_R / d; }
  }
}

/**
 * Resolve body overlap between every pair of actors.
 *
 * Without this the player walks straight through the horde and enemies stack
 * inside one another — the single most immersion-breaking thing in the build,
 * and the reason a crowd never felt like a crowd. Mass-weighted so the heavy
 * fighters shove and the light ones get shoved, which is most of what makes
 * body contact read as weight rather than as a soft repulsion field.
 */
const _sepA = new THREE.Vector3();
export function resolveBodies(actors, dt) {
  for (let i = 0; i < actors.length; i++) {
    const a = actors[i];
    if (a.dead) continue;
    for (let j = i + 1; j < actors.length; j++) {
      const b = actors[j];
      if (b.dead) continue;
      const d = _sepA.copy(b.root.position).sub(a.root.position);
      d.y = 0;
      const dist = d.length();
      const minD = a.radius + b.radius;
      if (dist >= minD || dist < 1e-5) continue;
      const push = (minD - dist) / dist;
      // Heavier actor moves less. Player mass is deliberately high so the
      // hero can wade into a pack rather than being swept around by it.
      const ma = a.mass ?? 1, mb = b.mass ?? 1;
      const total = ma + mb;
      a.root.position.addScaledVector(d, -push * (mb / total));
      b.root.position.addScaledVector(d, push * (ma / total));
      // Transfer a little velocity so a shove has follow-through.
      const k = Math.min(1, dt * 12);
      a.vel.addScaledVector(d, -push * (mb / total) * k * 8);
      b.vel.addScaledVector(d, push * (ma / total) * k * 8);
    }
  }
}

/* ------------------------------- player ------------------------------ */

export class Player extends Actor {
  constructor(root) {
    super(root, { hp: 200, speed: 2.7, radius: 0.45, mass: 3.2 });
    this.state = 'idle';
    this.t = 0;
    this.combo = 0;
    this.iframes = 0;
    this.stamina = 100;
    this.rage = 0;
    this.parryWindow = 0;      // ART_BIBLE §11: 120 ms
    this.blockHeld = 0;
    this.sinceAttack = 99;
    this.hitbox = { active: false, reach: 2.3, arc: 1.5, damage: 34 };
    this.anim = new Animator(root, HERO_ANIM);
  }

  update(dt, input, camera, enemies, fx) {
    this.updateCommon(dt);
    if (this.dead) return;
    this.t += dt;
    this.iframes = Math.max(0, this.iframes - dt);
    this.parryWindow = Math.max(0, this.parryWindow - dt);
    this.sinceAttack += dt;
    // A guard raised this frame opens a 120 ms parry; holding it past that is
    // an ordinary block.
    if (input.block) {
      if (this.blockHeld === 0) this.parryWindow = 0.12;
      this.blockHeld += dt;
    } else this.blockHeld = 0;
    // Combo must lapse, or attacking once and waiting still lands the heavy.
    if (this.sinceAttack > 0.7) this.combo = -1;
    this.stamina = Math.min(100, this.stamina + dt * 26);
    this.hitbox.active = false;

    const busy = this.state === 'attack' || this.state === 'dodge';

    // Movement is camera-relative, which is what makes an OTS game feel right.
    if (!busy) {
      const m = input.move();
      const fwd = _v1;
      camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      const right = _v2.crossVectors(fwd, UP).normalize();
      const dir = _v3.set(0, 0, 0)
        .addScaledVector(right, m.x).addScaledVector(fwd, -m.y);
      const moving = dir.lengthSq() > 1e-4;
      const sp = this.speed * (input.block ? 0.4 : 1);

      // ---- rotational inertia ----
      //
      // `this.face = atan2(dir.x, dir.z)` ASSIGNED the facing straight from
      // input. Measured first-input yaw rate: -1722 deg/s, i.e. ~150 degrees
      // inside a single frame. Nothing with mass turns like that, and it is the
      // reason the character carved like a car rather than pivoting like a
      // body. Facing is now a target the actual facing chases at a finite rate
      // that FALLS with speed: quick on the spot, ponderous at a sprint.
      if (moving) this.faceTarget = Math.atan2(dir.x, dir.z);
      let dyaw = wrapPi(this.faceTarget - this.face);
      const speedNow = this.vel.length();
      const t01 = THREE.MathUtils.clamp(speedNow / Math.max(0.001, this.speed), 0, 1);
      const maxYaw = THREE.MathUtils.lerp(YAW_RATE_REST, YAW_RATE_SPRINT, t01);

      // A reversal at speed is a PIVOT, not a turn: plant, swing the hips
      // around, push off again. Entering it costs most of the speed, which is
      // exactly the cost the old lerp refused to pay -- through a 180 the
      // measured speed held 2.654 -> 2.681 m/s and at one point ACCELERATED.
      if (this.pivotT > 0) this.pivotT -= dt;
      else if (moving && speedNow > PIVOT_MIN_SPEED && Math.abs(dyaw) > PIVOT_ANGLE) {
        this.pivotT = PIVOT_TIME;
      }
      const pivoting = this.pivotT > 0;
      const yawStep = maxYaw * (pivoting ? PIVOT_YAW_BOOST : 1) * dt;
      const applied = THREE.MathUtils.clamp(dyaw, -yawStep, yawStep);
      this.face = wrapPi(this.face + applied);
      this.yawRate = dt > 0 ? applied / dt : 0;

      // ---- linear inertia ----
      //
      // The old code lerped the whole velocity VECTOR toward inputDir*maxSpeed.
      // Both have the same length, so a direction change merely ROTATED the
      // velocity and cost nothing. Split it instead: thrust acts along the
      // facing at a finite rate, and lateral velocity is bled off by a
      // deliberately WEAK grip term so turning scrubs speed the way it must.
      const prevSpeed = speedNow;
      _fwd.set(Math.sin(this.face), 0, Math.cos(this.face));
      let along = this.vel.dot(_fwd);
      _lat.copy(this.vel).addScaledVector(_fwd, -along);

      if (moving && !pivoting) {
        // Thrust only to the extent we are already pointing where we want to
        // go; sprinting sideways out of a turn should not be possible.
        const aim = Math.max(0, Math.cos(dyaw));
        along = Math.min(sp, along + ACCEL * aim * dt);
      } else {
        const brake = pivoting ? PIVOT_BRAKE : DECEL;
        along = Math.max(0, along - brake * dt);
      }
      // Weak grip: lateral speed decays, but slowly enough to read as a skid.
      _lat.multiplyScalar(Math.exp(-LATERAL_GRIP * dt));
      this.vel.copy(_lat).addScaledVector(_fwd, along);
      // Along-facing and lateral components can sum past the cap on the way out
      // of a turn: measured 3.01 m/s against a 2.76 top speed, which would
      // desync the locomotion clip that top speed exists to match.
      if (this.vel.lengthSq() > sp * sp) this.vel.setLength(sp);

      // Clamp to what LOCOMOTION can produce. Raw frame-to-frame acceleration
      // measured -403 m/s^2: collision clamps and crowd separation dump the
      // whole velocity in one frame, and feeding those spikes to the lean made
      // the pose twitch on contact instead of reading as weight. The character
      // never accelerates itself harder than the brake, so bound it there.
      const rawA = dt > 0 ? (this.vel.length() - prevSpeed) / dt : 0;
      this.accel = THREE.MathUtils.clamp(rawA, -PIVOT_BRAKE, ACCEL);
      this.state = pivoting ? 'pivot' : (speedNow > 0.15 || moving ? 'run' : 'idle');

      if (input.consumeDodge() && this.stamina > 25) {
        this.state = 'dodge'; this.t = 0; this.stamina -= 25;
        this.iframes = 0.30;   // ART_BIBLE §11
        const d = moving ? _v4.copy(dir).normalize()
          : _v4.set(Math.sin(this.face), 0, Math.cos(this.face)).negate();
        // Ramped, not stepped: `vel.copy()` here measured 3.44 -> 8.44 m/s in
        // ONE frame (~30 g). Store a target and accelerate toward it.
        this._burst = d.clone().multiplyScalar(9.5);
        this._burstT = 0.10;
      } else if (input.consumeAttack() && this.stamina > 12) {
        this.state = 'attack'; this.t = 0; this.stamina -= 12;
        this.combo = (this.combo + 1) % 3;
        this.sinceAttack = 0;
        this._swung = false;
      }
    }

    if (this.state === 'attack') {
      const dur = this.combo === 2 ? 0.62 : 0.44;
      const k = this.t / dur;
      // Commitment: no cancelling after the windup. §11.
      if (k < 0.28) {
        this.vel.multiplyScalar(Math.exp(-9 * dt));            // wind up
      } else if (k < 0.46) {
        const f = _v1.set(Math.sin(this.face), 0, Math.cos(this.face));
        this._burst = f.clone().multiplyScalar(this.combo === 2 ? 6.5 : 4.4);
        this._burstT = 0.08;                                            // lunge
      } else {
        this.vel.multiplyScalar(Math.exp(-14 * dt));           // recovery
      }
      if (!this._swung && k >= 0.34 && k <= 0.52) {
        this._swung = true;
        this.hitbox.active = true;
        this.swing(enemies, fx);
      }
      if (this.t >= dur) { this.state = 'idle'; }
    } else if (this.state === 'dodge') {
      this.vel.multiplyScalar(Math.exp(-7 * dt));
      if (this.t >= 0.38) this.state = 'idle';
    }

    // Apply any pending burst over a short ramp rather than in a single frame.
    if (this._burstT > 0) {
      this._burstT -= dt;
      this.vel.lerp(this._burst, 1 - Math.exp(-26 * dt));
    }

    this.root.position.addScaledVector(this.vel, dt);
    this.root.position.addScaledVector(this._recoil, dt * 8);
    this.clampToArena();
    this.root.rotation.y = this.face + Math.PI;

    // The animator must see the ground speed actually achieved, not the speed
    // requested. Collision and arena clamping both move the root after velocity
    // is chosen, so `vel` overstates it — pinned against the bound, 85% of
    // frames had realized speed below half of `vel`, i.e. a full stride cycle
    // going nowhere.
    const realized = this._prevPos
      ? _v1.copy(this.root.position).sub(this._prevPos).setY(0).length() / Math.max(dt, 1e-4)
      : this.vel.length();
    (this._prevPos ||= new THREE.Vector3()).copy(this.root.position);

    // Footsteps fire off the animator's stride phase, so they land on the
    // planted foot rather than on an independent timer that drifts out of sync.
    if (this.anim && this.anim.ok) {
      const ph = this.anim.phase;
      const step = Math.floor(ph / Math.PI);
      if (step !== this._lastStep && this.vel.lengthSq() > 1.2) {
        this._lastStep = step;
        fx.audio?.footstep(Math.min(1, this.vel.length() / 3.4));
      }
    }

    // Body motion is skeletal now; the root only carries yaw.
    const dur = this.combo === 2 ? 0.62 : 0.44;
    this.anim?.update(dt, realized,
      this.state === 'attack'
        ? { active: true, k: Math.min(1, this.t / dur), combo: this.combo }
        : null,
      0,
      // The animator used to receive ONE scalar (speed) and pick between three
      // clips by threshold. Because the old controller held speed nearly
      // constant through every turn, start and stop, that scalar barely moved
      // and there was no signal to animate a transition WITH, even in
      // principle. Hand it the dynamics too.
      { yawRate: this.yawRate, accel: this.accel, pivot: this.state === 'pivot' });
    // NOTE: a two-bone foot-lock IK was tried here and removed. It wrote bad
    // quaternions that flung the legs — measured foot world-Y went from 0.58m
    // to 1.62m, i.e. above the hip. Speed-matched stride (anim/procedural.js)
    // is the correct primary fix for sliding; IK is only worth reintroducing
    // with a solver that is verified in isolation first.
  }

  swing(enemies, fx) {
    const origin = this.root.position;
    const f = _v1.set(Math.sin(this.face), 0, Math.cos(this.face));
    let hit = 0;
    for (const e of enemies) {
      if (e.dead) continue;
      const to = _v2.copy(e.root.position).sub(origin); to.y = 0;
      const dist = to.length();
      if (dist > this.hitbox.reach + e.radius) continue;
      if (to.normalize().dot(f) < Math.cos(this.hitbox.arc * 0.5)) continue;
      const dmg = this.hitbox.damage * (this.combo === 2 ? 1.8 : 1);
      // The finisher launches; the light hits nudge. A hit that does not move
      // the target reads as a decal rather than as force.
      const impulse = this.combo === 2 ? 9.5 : 3.2;
      e.hurt(dmg, to, impulse);
      // Max, not assign: hurt() already derived a stagger from the impulse and
      // this must not clobber it downward on a heavy blow.
      e.stagger = Math.max(e.stagger, this.combo === 2 ? 0.85 : 0.42);
      hit++;
      this.rage = Math.min(100, this.rage + 8);
      if (e.dead) fx.audio?.death();
      fx.impact(_v3.copy(e.root.position).setY(1.15), this.combo === 2 ? 1 : 0.62);
    }
    fx.swing(_v3.copy(origin).addScaledVector(f, 1.2).setY(1.25), this.combo);
    fx.audio?.whoosh(this.combo === 2 ? 1.3 : 1.0);
    if (hit === 0) fx.whiff();
  }
}

/* ------------------------------- enemy ------------------------------- */

export class Zombie extends Actor {
  constructor(root) {
    super(root, { hp: 100, speed: 1.55, radius: 0.42, mass: 1.0 });
    this.stagger = 0;
    this.hitSeverity = 0;
    this._releaseToken = false;
    this.attackCd = 1.2 + Math.random();
    this.state = 'idle';
    this.telegraph = 0;
    this.hasToken = false;
    this.ringTarget = null;
    this.director = null;
    this._t = Math.random() * 10;
    // Silhouette variety: a pack of identical models at identical scale merges
    // into one mass at combat distance. ART_BIBLE §9.
    // Real weight classes. Previously every draugr was mass 1.0, so the
    // mass-scaled knockback had nothing to scale against and heavy and light
    // enemies felt identical.
    const v = 0.82 + Math.random() * 0.42;
    root.scale.setScalar(v);
    this.mass = v * v * v * 1.35;            // mass goes as volume
    this.speed *= 1.22 - (v - 0.82) * 0.85;  // bigger = slower
    this.radius *= v;
    this.maxHp = this.hp = 100 * v * v;
    this.anim = new Animator(root, ZOMBIE_ANIM);
  }

  update(dt, player, fx, others) {
    this.updateCommon(dt);
    if (this.dead) return;
    this._t += dt;
    this.stagger = Math.max(0, this.stagger - dt);
    this.telegraph = Math.max(0, this.telegraph - dt * 2.4);
    this.attackCd -= dt;

    const to = _v1.copy(player.root.position).sub(this.root.position); to.y = 0;
    const dist = to.length();
    if (dist > 1e-3) this.face = Math.atan2(to.x, to.z);

    if (this.stagger > 0) {
      // RIDE the knockback. This branch used to damp velocity at 10/s, which
      // is exp(-10*0.245) = 0.086 -- 91% of the impulse gone inside 245ms.
      // Measured consequence: a light hit peaked at 1.6 m/s, netted ~5cm, and
      // the enemy then CLOSED distance (1.418 -> 1.072 m) because the walk
      // resumed while the player was still in swing recovery. A hit that does
      // not move the target reads as a decal rather than as force. Ground
      // friction only, so the shove actually carries.
      this.vel.multiplyScalar(Math.exp(-STAGGER_FRICTION * dt));
      this.state = 'stagger';
      // Hand the attack token back the moment the swing is interrupted.
      // Holding it through a stagger let a staggered draugr keep one of the
      // director's two slots reserved while it was incapable of using it, so
      // the pack went quiet every time the player connected.
      if (this._releaseToken) {
        if (this.hasToken && this.director) this.director.release(this);
        this._releaseToken = false;
      }
    } else if (!this.hasToken && this.ringTarget) {
      // No token: hold a slot on the ring and face the player. Circling rather
      // than crowding is what makes the pack readable and gives the player
      // room to actually use the parry and dodge windows.
      const toRing = _v2.copy(this.ringTarget).sub(this.root.position);
      toRing.y = 0;
      const rd = toRing.length();
      if (rd > 0.35) {
        toRing.normalize();
        const sep = _v3.set(0, 0, 0);
        for (const o of others) {
          if (o === this || o.dead) continue;
          const off = _v4.copy(this.root.position).sub(o.root.position); off.y = 0;
          const l = off.length();
          if (l < 1.9 && l > 1e-3) sep.add(off.multiplyScalar((1.9 - l) / l));
        }
        toRing.addScaledVector(sep, 0.7).normalize();
        const gait = 0.62 + 0.30 * Math.max(0, Math.sin(this._t * 3.1));
        this.vel.lerp(toRing.multiplyScalar(this.speed * 0.78 * gait),
          1 - Math.exp(-7 * dt));
      } else {
        this.vel.multiplyScalar(Math.exp(-9 * dt));
      }
      this.state = rd > 0.35 ? 'walk' : 'idle';
    } else if (dist > 1.5) {
      const d = to.normalize();
      // Separation so the pack doesn't collapse into one silhouette.
      const sep = _v2.set(0, 0, 0);
      for (const o of others) {
        if (o === this || o.dead) continue;
        const off = _v3.copy(this.root.position).sub(o.root.position); off.y = 0;
        const l = off.length();
        if (l < 1.9 && l > 1e-3) sep.add(off.multiplyScalar((1.9 - l) / l));
      }
      d.addScaledVector(sep, 0.8).normalize();
      // Shambling gait: speed pulses rather than holding constant.
      const gait = 0.72 + 0.42 * Math.max(0, Math.sin(this._t * 3.1));
      this.vel.lerp(d.multiplyScalar(this.speed * gait), 1 - Math.exp(-8 * dt));
      this.state = 'walk';
    } else {
      this.vel.multiplyScalar(Math.exp(-12 * dt));
      if (this.attackCd <= 0 && this.hasToken &&
          (!this.director || this.director.requestSwing())) {
        this.attackCd = 1.6 + Math.random() * 1.2;
        this.state = 'attack';
        this._swingAt = 0.42;
        this.telegraph = 1;          // drives a readable wind-up + rim flash
      }
    }

    if (this.state === 'attack') {
      this._swingAt -= dt;
      if (this._swingAt !== undefined && this._swingAt <= 0 && this._swingAt > -0.05) {
        const d2 = player.root.position.distanceTo(this.root.position);
        if (d2 < 2.0 && player.iframes <= 0 && !player.dead) {
          const from = _v4.copy(this.root.position).sub(player.root.position);
          if (player.parryWindow > 0) {
            // Parry: no damage, the attacker is staggered and pushed back.
            this.stagger = 0.9;
            this.hurt(0, _v2.copy(from).negate());
            player.rage = Math.min(100, player.rage + 18);
            fx.parry(_v2.copy(this.root.position).setY(1.2));
          } else if (player.blockHeld > 0 && player.stamina > 15) {
            player.stamina -= 18;
            player.hurt(3, from);
            fx.blocked(_v2.copy(player.root.position).setY(1.2));
          } else {
            player.hurt(12, from, 2.4);
            fx.playerHit();
          }
        }
        this._swingAt = -1;
      }
      if (this._swingAt < -0.35) {
        this.state = 'idle';
        if (this.hasToken && this.director) this.director.release(this);
      }
    }

    this.root.position.addScaledVector(this.vel, dt);
    this.root.position.addScaledVector(this._recoil, dt * 10);
    this.clampToArena();
    this.root.rotation.y = this.face + Math.PI;

    // Telegraph: a readable wind-up the animator plays, not a 14-degree root
    // lean on a grey figure the player cannot see at 8 m.
    const zRealized = this._prevPos
      ? _v1.copy(this.root.position).sub(this._prevPos).setY(0).length() / Math.max(dt, 1e-4)
      : this.vel.length();
    (this._prevPos ||= new THREE.Vector3()).copy(this.root.position);
    this.anim?.update(dt, zRealized,
      this.state === 'attack'
        ? { active: true, k: Math.max(0, 1 - Math.max(0, this._swingAt) / 0.42), combo: 0 }
        : null,
      0,
      // The animator used to receive ONE scalar (speed) and pick between three
      // clips by threshold. Because the old controller held speed nearly
      // constant through every turn, start and stop, that scalar barely moved
      // and there was no signal to animate a transition WITH, even in
      // principle. Hand it the dynamics too.
      { yawRate: this.yawRate, accel: this.accel, pivot: this.state === 'pivot' });

  }
}
