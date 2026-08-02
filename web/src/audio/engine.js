/**
 * Procedural combat audio.
 *
 * Everything is synthesised at runtime rather than shipped as samples. For
 * impacts that is not a compromise: a metal hit IS a broadband transient plus a
 * few resonant partials decaying at different rates, which is easier to control
 * — and to vary per hit — as synthesis than as a handful of files. It also
 * costs zero download on a build where assets are already the heavy part.
 *
 * Every one-shot is randomised in pitch and timbre. Identical repeated sounds
 * are the fastest way to make combat feel cheap.
 */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.ready = false;
    this.muted = false;
  }

  /** Browsers require a gesture before audio starts; call from first input. */
  async unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return;
    }
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    this.ctx = ctx;

    this.master = ctx.createGain();
    this.master.gain.value = 0.85;
    this.master.connect(ctx.destination);

    // Gentle bus compression so a four-enemy pile-on doesn't clip.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 22;
    comp.ratio.value = 5;
    comp.attack.value = 0.004;
    comp.release.value = 0.16;
    comp.connect(this.master);
    this.bus = comp;

    // Convolution reverb from a synthesised impulse: exponentially decaying
    // noise, slightly stereo-decorrelated. A ruined stone yard is reflective,
    // and dry combat hits read as if they happened in a vacuum.
    const dur = 1.5, rate = ctx.sampleRate;
    const ir = ctx.createBuffer(2, Math.floor(rate * dur), rate);
    for (let c = 0; c < 2; c++) {
      const d = ir.getChannelData(c);
      for (let i = 0; i < d.length; i++) {
        const t = i / d.length;
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6) * (1 - t * 0.2);
      }
    }
    this.verb = ctx.createConvolver();
    this.verb.buffer = ir;
    this.verbGain = ctx.createGain();
    this.verbGain.gain.value = 0.22;
    this.verb.connect(this.verbGain);
    this.verbGain.connect(this.master);

    this._noise = this._makeNoise(2.0);
    this.ready = true;
    this._startAmbience();
  }

  _makeNoise(seconds) {
    const ctx = this.ctx;
    const b = ctx.createBuffer(1, Math.floor(ctx.sampleRate * seconds), ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  }

  _noiseSource(playbackRate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this._noise;
    s.loop = true;
    s.playbackRate.value = playbackRate;
    return s;
  }

  _env(node, t0, peak, attack, decay) {
    const g = node.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(0.0002, peak), t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  _send(node, wet = 0.35) {
    node.connect(this.bus);
    const s = this.ctx.createGain();
    s.gain.value = wet;
    node.connect(s);
    s.connect(this.verb);
  }

  /* ------------------------------ one-shots ------------------------------ */

  /**
   * Weapon on flesh/bone. Broadband transient, a low thud body, and two
   * resonant partials for the metal.
   * @param power 0..1
   */
  impact(power = 1) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const p = clamp(power, 0.2, 1.4);

    // Transient: short bright noise burst through a bandpass.
    const n = this._noiseSource(1 + Math.random() * 0.3);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400 + Math.random() * 900;
    bp.Q.value = 0.8;
    const ng = ctx.createGain();
    n.connect(bp); bp.connect(ng);
    this._env(ng, t, 0.55 * p, 0.002, 0.075);
    this._send(ng, 0.30);
    n.start(t); n.stop(t + 0.20);

    // Body: low sine thud, pitch-dropping.
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150 + Math.random() * 40, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.16);
    const og = ctx.createGain();
    o.connect(og);
    this._env(og, t, 0.72 * p, 0.004, 0.20);
    this._send(og, 0.18);
    o.start(t); o.stop(t + 0.32);

    // Metal partials — inharmonic on purpose; harmonic ones read as a bell.
    for (const [mult, gain, dec] of [[1.0, 0.16, 0.34], [2.71, 0.09, 0.22]]) {
      const m = ctx.createOscillator();
      m.type = 'triangle';
      m.frequency.value = (620 + Math.random() * 180) * mult;
      const mg = ctx.createGain();
      m.connect(mg);
      this._env(mg, t, gain * p, 0.003, dec);
      this._send(mg, 0.45);
      m.start(t); m.stop(t + dec + 0.1);
    }
  }

  /** Blade through air. Bandpass noise with a sweeping centre frequency. */
  whoosh(power = 1) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = this._noiseSource(1);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 3.2;
    bp.frequency.setValueAtTime(320, t);
    bp.frequency.exponentialRampToValueAtTime(1800 + power * 900, t + 0.13);
    bp.frequency.exponentialRampToValueAtTime(420, t + 0.30);
    const g = ctx.createGain();
    n.connect(bp); bp.connect(g);
    this._env(g, t, 0.30 * power, 0.03, 0.26);
    this._send(g, 0.35);
    n.start(t); n.stop(t + 0.36);
  }

  /** Parry: bright metallic ring, clearly distinct from a normal hit. */
  parry() {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    for (const [f, gn, d] of [[2100, 0.22, 0.5], [3170, 0.14, 0.42], [4700, 0.08, 0.30]]) {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = f * (0.97 + Math.random() * 0.06);
      const g = ctx.createGain();
      o.connect(g);
      this._env(g, t, gn, 0.002, d);
      this._send(g, 0.55);
      o.start(t); o.stop(t + d + 0.1);
    }
    const n = this._noiseSource(1.4);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 2600;
    const g = ctx.createGain();
    n.connect(hp); hp.connect(g);
    this._env(g, t, 0.30, 0.001, 0.09);
    this._send(g, 0.4);
    n.start(t); n.stop(t + 0.16);
  }

  /** Player takes damage: dull low thud plus a brief muffling of everything. */
  hurt() {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(120, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.25);
    const g = ctx.createGain();
    o.connect(g);
    this._env(g, t, 0.85, 0.005, 0.30);
    this._send(g, 0.2);
    o.start(t); o.stop(t + 0.4);
    // Duck the master briefly — a concussive "ring" without a real filter sweep.
    const m = this.master.gain;
    m.cancelScheduledValues(t);
    m.setValueAtTime(0.85, t);
    m.linearRampToValueAtTime(0.42, t + 0.03);
    m.linearRampToValueAtTime(0.85, t + 0.55);
  }

  footstep(power = 1) {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = this._noiseSource(0.8 + Math.random() * 0.5);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900 + Math.random() * 500;
    const g = ctx.createGain();
    n.connect(lp); lp.connect(g);
    this._env(g, t, 0.16 * power, 0.004, 0.085);
    this._send(g, 0.22);
    n.start(t); n.stop(t + 0.14);
  }

  death() {
    if (!this.ready || this.muted) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const n = this._noiseSource(0.7);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(1200, t);
    lp.frequency.exponentialRampToValueAtTime(180, t + 0.5);
    const g = ctx.createGain();
    n.connect(lp); lp.connect(g);
    this._env(g, t, 0.35, 0.01, 0.55);
    this._send(g, 0.5);
    n.start(t); n.stop(t + 0.7);
  }

  /* ------------------------------ ambience ------------------------------ */

  _startAmbience() {
    const ctx = this.ctx;
    // Wind bed: noise through a slowly wandering bandpass, kept well under the
    // combat layer so it reads as place rather than as noise.
    const n = this._noiseSource(0.35);
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 420;
    bp.Q.value = 0.55;
    const g = ctx.createGain();
    g.gain.value = 0.055;
    n.connect(bp); bp.connect(g); g.connect(this.master);

    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 230;
    lfo.connect(lfoGain);
    lfoGain.connect(bp.frequency);
    lfo.start();

    const swell = ctx.createOscillator();
    swell.frequency.value = 0.045;
    const swellGain = ctx.createGain();
    swellGain.gain.value = 0.032;
    swell.connect(swellGain);
    swellGain.connect(g.gain);
    swell.start();

    n.start();
    this._wind = { n, bp, g };

    // Low drone for dread. Two detuned oscillators a fifth apart, very quiet.
    for (const [f, gain] of [[55, 0.030], [82.5, 0.018]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 220;
      const og = ctx.createGain();
      og.gain.value = gain;
      o.connect(lp); lp.connect(og); og.connect(this.master);
      o.start();
    }
  }

  setMuted(v) {
    this.muted = v;
    if (this.master) this.master.gain.value = v ? 0 : 0.85;
  }
}
