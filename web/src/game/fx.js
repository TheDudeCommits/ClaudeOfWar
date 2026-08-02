import * as THREE from 'three';

/**
 * Combat feedback: hitstop, impact lights, sparks and weapon trails.
 *
 * ART_BIBLE §10 — "impact = light". A brief warm omni at the contact point is
 * the cheapest thing that makes a hit feel like it landed, because it changes
 * the shading on both actors for a few frames rather than just adding a decal
 * on top of the frame.
 */
export class CombatFX {
  constructor(scene, camera, ots) {
    this.scene = scene;
    this.camera = camera;
    this.ots = ots;
    this.hitstop = 0;
    this._lights = [];
    this._sparks = [];

    // A small pool, because allocating a PointLight mid-combat causes a shader
    // recompile stall on first use.
    for (let i = 0; i < 4; i++) {
      const l = new THREE.PointLight(0xffd0a0, 0, 5.5, 2);
      l.visible = false;
      scene.add(l);
      this._lights.push({ light: l, t: 0 });
    }

    const g = new THREE.BufferGeometry();
    const N = 240;
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('aVel', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    g.setAttribute('aLife', new THREE.BufferAttribute(new Float32Array(N), 1));
    this._sparkGeo = g;
    this._sparkN = N;
    this._sparkHead = 0;
    const m = new THREE.PointsMaterial({
      size: 0.055, sizeAttenuation: true, color: 0xffc98a,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this._sparkPts = new THREE.Points(g, m);
    this._sparkPts.frustumCulled = false;
    scene.add(this._sparkPts);

    // Weapon arc: a short additive ribbon that fades over a few frames.
    const tg = new THREE.PlaneGeometry(1.9, 0.30, 12, 1);
    this._trailMat = new THREE.MeshBasicMaterial({
      color: 0xdfe9ff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending,
      depthWrite: false, side: THREE.DoubleSide,
    });
    this._trail = new THREE.Mesh(tg, this._trailMat);
    this._trail.visible = false;
    scene.add(this._trail);
    this._trailT = 0;
  }

  /** Freeze both actors briefly. 60-110ms scaled by damage. ART_BIBLE §11. */
  impact(pos, power = 1) {
    this.hitstop = Math.max(this.hitstop, 0.06 + 0.05 * power);
    const slot = this._lights.find(l => l.t <= 0) || this._lights[0];
    slot.light.position.copy(pos);
    slot.light.intensity = 14 * power;
    slot.light.visible = true;
    slot.t = 0.09;
    this.ots?.impact(0.42 * power + 0.12, -5.5 * power);
    this._emitSparks(pos, 18 + Math.floor(22 * power), power);
  }

  swing(pos, combo) {
    this._trail.visible = true;
    this._trail.position.copy(pos);
    this._trail.lookAt(this.camera.position);
    this._trail.rotation.z = combo * 0.7 - 0.4;
    this._trailT = combo === 2 ? 0.16 : 0.11;
  }

  whiff() { this.ots?.impact(0.05, -1.0); }

  playerHit() {
    this.hitstop = Math.max(this.hitstop, 0.07);
    this.ots?.impact(0.55, -7);
  }

  _emitSparks(pos, n, power) {
    const p = this._sparkGeo.attributes.position.array;
    const v = this._sparkGeo.attributes.aVel.array;
    const l = this._sparkGeo.attributes.aLife.array;
    for (let i = 0; i < n; i++) {
      const k = this._sparkHead;
      this._sparkHead = (this._sparkHead + 1) % this._sparkN;
      p[k * 3] = pos.x; p[k * 3 + 1] = pos.y; p[k * 3 + 2] = pos.z;
      const sp = (1.6 + Math.random() * 3.4) * power;
      const th = Math.random() * Math.PI * 2, ph = Math.random() * Math.PI - Math.PI / 2;
      v[k * 3] = Math.cos(th) * Math.cos(ph) * sp;
      v[k * 3 + 1] = Math.sin(ph) * sp + 1.8;
      v[k * 3 + 2] = Math.sin(th) * Math.cos(ph) * sp;
      l[k] = 0.30 + Math.random() * 0.25;
    }
  }

  /** Returns the scaled dt the rest of the sim should use. */
  update(dt) {
    if (this.hitstop > 0) {
      this.hitstop -= dt;
      dt *= 0.06;    // near-freeze, not a full stop — a full stop reads as a hitch
    }
    for (const s of this._lights) {
      if (s.t > 0) {
        s.t -= dt;
        s.light.intensity *= Math.exp(-26 * dt);
        if (s.t <= 0) { s.light.visible = false; s.light.intensity = 0; }
      }
    }
    const p = this._sparkGeo.attributes.position.array;
    const v = this._sparkGeo.attributes.aVel.array;
    const l = this._sparkGeo.attributes.aLife.array;
    let any = false;
    for (let i = 0; i < this._sparkN; i++) {
      if (l[i] <= 0) continue;
      any = true;
      l[i] -= dt;
      v[i * 3 + 1] -= 15 * dt;                 // gravity
      const drag = Math.exp(-3.2 * dt);
      v[i * 3] *= drag; v[i * 3 + 1] *= drag; v[i * 3 + 2] *= drag;
      p[i * 3] += v[i * 3] * dt;
      p[i * 3 + 1] += v[i * 3 + 1] * dt;
      p[i * 3 + 2] += v[i * 3 + 2] * dt;
      if (l[i] <= 0) { p[i * 3 + 1] = -999; }
    }
    if (any) this._sparkGeo.attributes.position.needsUpdate = true;

    if (this._trailT > 0) {
      this._trailT -= dt;
      this._trailMat.opacity = Math.max(0, this._trailT * 5.5);
      if (this._trailT <= 0) this._trail.visible = false;
    }
    return dt;
  }
}
