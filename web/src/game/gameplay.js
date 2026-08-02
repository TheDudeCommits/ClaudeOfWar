import * as THREE from 'three';

/**
 * Player control, melee combat and enemy AI.
 *
 * The character GLBs ship with a single animation clip each, so there is no
 * attack/hit/death animation to play. Rather than leave combat unanimated, the
 * motion here is procedural: attacks are a lunge plus a torso twist driven on
 * the root, hits are an additive recoil, and deaths are a weighted topple. With
 * hitstop and a camera punch layered on, that reads as impact far better than a
 * static pose would — ART_BIBLE §11 is mostly about timing, not keyframes.
 */

const UP = new THREE.Vector3(0, 1, 0);
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

class Actor {
  constructor(root, opts = {}) {
    this.root = root;
    this.hp = opts.hp ?? 100;
    this.maxHp = this.hp;
    this.speed = opts.speed ?? 3.2;
    this.radius = opts.radius ?? 0.42;
    this.dead = false;
    this.vel = new THREE.Vector3();
    this.face = 0;              // yaw
    this._recoil = new THREE.Vector3();
    this._deathT = 0;
    this._flash = 0;
    this._baseY = root.position.y;
  }

  hurt(amount, fromDir) {
    if (this.dead) return false;
    this.hp -= amount;
    this._flash = 1;
    // Directional additive recoil rather than a canned reaction clip.
    this._recoil.copy(fromDir).setY(0).normalize().multiplyScalar(0.22);
    if (this.hp <= 0) { this.dead = true; this._deathT = 0; }
    return true;
  }

  updateCommon(dt) {
    this._flash = Math.max(0, this._flash - dt * 5);
    this._recoil.multiplyScalar(Math.exp(-12 * dt));
    if (this.dead) {
      this._deathT = Math.min(1, this._deathT + dt * 1.6);
      const t = this._deathT;
      // Topple with a bit of overshoot so it settles rather than snapping flat.
      const fall = 1 - Math.pow(1 - t, 3);
      this.root.rotation.x = -fall * Math.PI * 0.48;
      this.root.position.y = this._baseY - fall * 0.15;
    }
  }

  clampToArena() {
    const p = this.root.position;
    const d = Math.hypot(p.x, p.z);
    if (d > ARENA_R) { p.x *= ARENA_R / d; p.z *= ARENA_R / d; }
  }
}

/* ------------------------------- player ------------------------------ */

export class Player extends Actor {
  constructor(root) {
    super(root, { hp: 200, speed: 3.4, radius: 0.45 });
    this.state = 'idle';
    this.t = 0;
    this.combo = 0;
    this.iframes = 0;
    this.stamina = 100;
    this.rage = 0;
    this.hitbox = { active: false, reach: 2.3, arc: 1.5, damage: 34 };
  }

  update(dt, input, camera, enemies, fx) {
    this.updateCommon(dt);
    if (this.dead) return;
    this.t += dt;
    this.iframes = Math.max(0, this.iframes - dt);
    this.stamina = Math.min(100, this.stamina + dt * 26);
    this.hitbox.active = false;

    const busy = this.state === 'attack' || this.state === 'dodge';

    // Movement is camera-relative, which is what makes an OTS game feel right.
    if (!busy) {
      const m = input.move();
      const fwd = new THREE.Vector3();
      camera.getWorldDirection(fwd); fwd.y = 0; fwd.normalize();
      const right = new THREE.Vector3().crossVectors(fwd, UP).normalize();
      const dir = new THREE.Vector3()
        .addScaledVector(right, m.x).addScaledVector(fwd, -m.y);
      const moving = dir.lengthSq() > 1e-4;
      if (moving) {
        dir.normalize();
        const sp = this.speed * (input.block ? 0.4 : 1);
        this.vel.lerp(dir.multiplyScalar(sp), 1 - Math.exp(-14 * dt));
        this.face = Math.atan2(dir.x, dir.z);
      } else {
        this.vel.lerp(new THREE.Vector3(), 1 - Math.exp(-18 * dt));
      }
      this.state = moving ? 'run' : 'idle';

      if (input.consumeDodge() && this.stamina > 25) {
        this.state = 'dodge'; this.t = 0; this.stamina -= 25;
        this.iframes = 0.30;   // ART_BIBLE §11
        const d = moving ? dir.clone().normalize()
          : new THREE.Vector3(Math.sin(this.face), 0, Math.cos(this.face)).negate();
        this.vel.copy(d.multiplyScalar(9.5));
      } else if (input.consumeAttack() && this.stamina > 12) {
        this.state = 'attack'; this.t = 0; this.stamina -= 12;
        this.combo = (this.combo + 1) % 3;
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
        const f = new THREE.Vector3(Math.sin(this.face), 0, Math.cos(this.face));
        this.vel.copy(f.multiplyScalar(this.combo === 2 ? 6.5 : 4.4));  // lunge
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

    this.root.position.addScaledVector(this.vel, dt);
    this.root.position.add(this._recoil.clone().multiplyScalar(dt * 8));
    this.clampToArena();
    this.root.rotation.y = this.face + Math.PI;

    // Attack pose: lean into the swing. Purely procedural, on the root.
    let lean = 0;
    if (this.state === 'attack') {
      const dur = this.combo === 2 ? 0.62 : 0.44;
      const k = this.t / dur;
      lean = k < 0.3 ? -k * 0.5 : Math.sin((k - 0.3) / 0.7 * Math.PI) * 0.42;
    }
    this.root.rotation.x = lean;
  }

  swing(enemies, fx) {
    const origin = this.root.position;
    const f = new THREE.Vector3(Math.sin(this.face), 0, Math.cos(this.face));
    let hit = 0;
    for (const e of enemies) {
      if (e.dead) continue;
      const to = e.root.position.clone().sub(origin); to.y = 0;
      const dist = to.length();
      if (dist > this.hitbox.reach + e.radius) continue;
      if (to.normalize().dot(f) < Math.cos(this.hitbox.arc * 0.5)) continue;
      const dmg = this.hitbox.damage * (this.combo === 2 ? 1.8 : 1);
      e.hurt(dmg, to);
      e.stagger = 0.42;
      hit++;
      this.rage = Math.min(100, this.rage + 8);
      fx.impact(e.root.position.clone().setY(1.15), this.combo === 2 ? 1 : 0.62);
    }
    fx.swing(origin.clone().addScaledVector(f, 1.2).setY(1.25), this.combo);
    if (hit === 0) fx.whiff();
  }
}

/* ------------------------------- enemy ------------------------------- */

export class Zombie extends Actor {
  constructor(root) {
    super(root, { hp: 100, speed: 1.55, radius: 0.42 });
    this.stagger = 0;
    this.attackCd = 1.2 + Math.random();
    this.state = 'idle';
    this._t = Math.random() * 10;
  }

  update(dt, player, fx, others) {
    this.updateCommon(dt);
    if (this.dead) return;
    this._t += dt;
    this.stagger = Math.max(0, this.stagger - dt);
    this.attackCd -= dt;

    const to = player.root.position.clone().sub(this.root.position); to.y = 0;
    const dist = to.length();
    if (dist > 1e-3) this.face = Math.atan2(to.x, to.z);

    if (this.stagger > 0) {
      this.vel.multiplyScalar(Math.exp(-10 * dt));
    } else if (dist > 1.5) {
      const d = to.normalize();
      // Separation so the pack doesn't collapse into one silhouette.
      const sep = new THREE.Vector3();
      for (const o of others) {
        if (o === this || o.dead) continue;
        const off = this.root.position.clone().sub(o.root.position); off.y = 0;
        const l = off.length();
        if (l < 1.1 && l > 1e-3) sep.add(off.multiplyScalar((1.1 - l) / l));
      }
      d.addScaledVector(sep, 0.8).normalize();
      // Shambling gait: speed pulses rather than holding constant.
      const gait = 0.72 + 0.42 * Math.max(0, Math.sin(this._t * 3.1));
      this.vel.lerp(d.multiplyScalar(this.speed * gait), 1 - Math.exp(-8 * dt));
      this.state = 'walk';
    } else {
      this.vel.multiplyScalar(Math.exp(-12 * dt));
      if (this.attackCd <= 0) {
        this.attackCd = 1.6 + Math.random() * 1.2;
        this.state = 'attack';
        this._swingAt = 0.34;
      }
    }

    if (this.state === 'attack') {
      this._swingAt -= dt;
      if (this._swingAt !== undefined && this._swingAt <= 0 && this._swingAt > -0.05) {
        const d2 = player.root.position.distanceTo(this.root.position);
        if (d2 < 2.0 && player.iframes <= 0 && !player.dead) {
          player.hurt(12, this.root.position.clone().sub(player.root.position));
          fx.playerHit();
        }
        this._swingAt = -1;
      }
      if (this._swingAt < -0.35) this.state = 'idle';
    }

    this.root.position.addScaledVector(this.vel, dt);
    this.root.position.add(this._recoil.clone().multiplyScalar(dt * 10));
    this.clampToArena();
    this.root.rotation.y = this.face + Math.PI;

    // Lurch on the walk cycle; a rigid translate reads as a sliding prop.
    if (!this.dead) {
      const bob = this.state === 'walk' ? Math.sin(this._t * 6.2) * 0.035 : 0;
      this.root.position.y = this._baseY + Math.abs(bob);
      this.root.rotation.z = this.state === 'walk' ? Math.sin(this._t * 3.1) * 0.06 : 0;
      this.root.rotation.x = this.state === 'attack' ? -0.25 : 0;
    }
  }
}
