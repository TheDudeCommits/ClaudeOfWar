import { Effect, BlendFunction } from 'postprocessing';
import { Uniform, Vector2, Vector3 } from 'three';

/**
 * Scene exposure, applied in HDR before the tonemap.
 *
 * The renderer runs with NoToneMapping so the composer owns ACES, which also
 * means `renderer.toneMappingExposure` is inert — without this the only way to
 * set exposure is retuning every light, and the frame blows out.
 */
export class ExposureEffect extends Effect {
  constructor(exposure = 1.0) {
    super('ExposureEffect', /* glsl */`
      uniform float exposure;
      void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
        outputColor = vec4(inputColor.rgb * exposure, inputColor.a);
      }`, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([['exposure', new Uniform(exposure)]]),
    });
  }
  set exposure(v) { this.uniforms.get('exposure').value = v; }
  get exposure() { return this.uniforms.get('exposure').value; }
}

/**
 * Final LDR finishing pass: chromatic aberration, filmic S-curve, saturation,
 * split-tone, film grain and vignette — all in one shader.
 *
 * These were four separate library effects. `ChromaticAberrationEffect` is
 * flagged as a CONVOLUTION effect, which forces it into a pass of its own and
 * measured ~40ms of a 57ms frame on an M2 Air. A radial 3-tap does the same job
 * for three texture reads, and folding grain/vignette in alongside it costs
 * nothing extra since we are already sampling here.
 *
 * This effect must be the ONLY one in its pass: it reads `inputBuffer`
 * directly, so it needs that buffer to be the tonemapped result rather than
 * some earlier stage of a merged pass.
 */
const frag = /* glsl */`
uniform vec3 shadowTint;
uniform vec3 highTint;
uniform float contrast;
uniform float saturation;
uniform float lift;
uniform float gamma;
uniform float caStrength;
uniform float grainAmount;
uniform float vignetteOffset;
uniform float vignetteDarkness;
uniform float time;

float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

float hash(vec2 p){
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  // Radial chromatic aberration: displace R and B outward from centre. Only
  // the two side channels need extra taps — green stays put.
  vec2 dir = uv - 0.5;
  float r2 = dot(dir, dir);
  vec2 off = dir * r2 * caStrength;
  vec3 c = vec3(
    texture2D(inputBuffer, uv + off).r,
    inputColor.g,
    texture2D(inputBuffer, uv - off).b
  );

  c = pow(max(c, 0.0), vec3(gamma));

  // Filmic S-curve around 0.5 pivot.
  c = clamp((c - 0.5) * contrast + 0.5, 0.0, 1.0);
  c = c * c * (3.0 - 2.0 * c) * 0.35 + c * 0.65;

  float l = luma(c);
  c = mix(vec3(l), c, saturation);

  // Split-tone: weight tints by tone zone so shadows go cool and highs warm
  // without flattening the midtones.
  // The shadow weight must fall back off approaching true black. Weighting it
  // by (1-l)^2 alone puts maximum tint exactly where the signal is weakest, so
  // a near-black pixel becomes pure tint colour — fully saturated blue — and
  // wrecks sat_mean the moment the black lift stops masking it.
  float sw = pow(1.0 - clamp(l, 0.0, 1.0), 2.0) * smoothstep(0.0, 0.09, l);
  float hw = pow(clamp(l, 0.0, 1.0), 2.0);
  c += shadowTint * sw + highTint * hw;

  // Lift LAST so it actually sets the black floor. Applied before the S-curve
  // it gets mapped back below zero by the contrast expansion and clamped to
  // pure black — the single most conspicuous amateur tell.
  //
  // NOTE the space: this shader runs on display-LINEAR values and the frame is
  // sRGB-encoded afterwards, so a lift of L lands at L^(1/2.2) in the measured
  // image. 0.022 here reads as 0.156 sRGB. To hit the reference's 0.019 sRGB
  // black point, lift must be ~0.019^2.2 = 0.0003.
  c = max(c, 0.0) * (1.0 - lift) + lift;

  // Animated grain, weighted toward the midtones so it doesn't crawl in the
  // blacks or fizz in the highlights.
  float g = hash(uv * 1024.0 + fract(time) * 91.7) - 0.5;
  c += g * grainAmount * (1.0 - abs(l * 2.0 - 1.0));

  // Soft elliptical vignette.
  float v = smoothstep(0.0, 1.0, 1.0 - (length(dir * vec2(1.0, 1.15)) - vignetteOffset));
  c *= mix(1.0, clamp(v, 0.0, 1.0), vignetteDarkness);

  outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
}
`;

export class GradeEffect extends Effect {
  constructor(opts = {}) {
    super('GradeEffect', frag, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['shadowTint', new Uniform(opts.shadowTint ?? new Vector3(-0.012, 0.004, 0.036))],
        ['highTint', new Uniform(opts.highTint ?? new Vector3(0.038, 0.016, -0.020))],
        ['contrast', new Uniform(opts.contrast ?? 1.12)],
        ['saturation', new Uniform(opts.saturation ?? 0.92)],
        ['lift', new Uniform(opts.lift ?? 0.002)],
        ['gamma', new Uniform(opts.gamma ?? 1.0)],
        // Displacement is dir*r2*caStrength, so at the frame corner (|dir|~0.7,
        // r2~0.5) this yields ~0.005 uv ~= 2px at 1080p. Values near 1.0 shift
        // samples by a third of the screen and produce rainbow garbage.
        ['caStrength', new Uniform(opts.caStrength ?? 0.015)],
        ['grainAmount', new Uniform(opts.grainAmount ?? 0.055)],
        ['vignetteOffset', new Uniform(opts.vignetteOffset ?? 0.24)],
        ['vignetteDarkness', new Uniform(opts.vignetteDarkness ?? 0.62)],
        ['time', new Uniform(0)],
      ]),
    });
  }
  update(renderer, inputBuffer, dt) {
    this.uniforms.get('time').value += dt;
  }
  set(k, v) {
    const u = this.uniforms.get(k);
    if (u) u.value = v;
  }
}
