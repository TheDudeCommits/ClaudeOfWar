import { Effect, BlendFunction } from 'postprocessing';
import { Uniform, Vector3 } from 'three';

/**
 * Colour grade: filmic S-curve, saturation trim, and shadow/highlight split-tone.
 *
 * The reference plates measure at a lifted black point (~0.019) with a gentle
 * teal/orange split — cool shadows, warm highlights — and mean saturation near
 * 0.29. An untouched render sits at zero split and crushed blacks, which reads
 * instantly as "engine output" rather than "graded frame". See docs/REF_STATS.md.
 */
const frag = /* glsl */`
uniform vec3 shadowTint;
uniform vec3 highTint;
uniform float contrast;
uniform float saturation;
uniform float lift;
uniform float gamma;

// Approximate luma in gamma space; matches how the reference stats are measured.
float luma(vec3 c){ return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 c = pow(max(inputColor.rgb, 0.0), vec3(gamma));

  // Filmic S-curve around 0.5 pivot.
  c = clamp((c - 0.5) * contrast + 0.5, 0.0, 1.0);
  c = c * c * (3.0 - 2.0 * c) * 0.35 + c * 0.65;

  float l = luma(c);
  c = mix(vec3(l), c, saturation);

  // Split-tone: weight tints by tone zone so shadows go cool and highs warm
  // without flattening the midtones.
  float sw = pow(1.0 - clamp(l, 0.0, 1.0), 2.0);
  float hw = pow(clamp(l, 0.0, 1.0), 2.0);
  c += shadowTint * sw + highTint * hw;

  // Lift LAST so it actually sets the black floor. Applied before the S-curve
  // it gets mapped back below zero by the contrast expansion and clamped to
  // pure black — which is the single most conspicuous amateur tell.
  c = max(c, 0.0) * (1.0 - lift) + lift;

  outputColor = vec4(clamp(c, 0.0, 1.0), inputColor.a);
}
`;

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

export class GradeEffect extends Effect {
  constructor(opts = {}) {
    super('GradeEffect', frag, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map([
        ['shadowTint', new Uniform(opts.shadowTint ?? new Vector3(-0.012, 0.004, 0.036))],
        ['highTint', new Uniform(opts.highTint ?? new Vector3(0.038, 0.016, -0.020))],
        ['contrast', new Uniform(opts.contrast ?? 1.12)],
        ['saturation', new Uniform(opts.saturation ?? 0.92)],
        ['lift', new Uniform(opts.lift ?? 0.022)],
        ['gamma', new Uniform(opts.gamma ?? 1.0)],
      ]),
    });
  }
  set(k, v) {
    const u = this.uniforms.get(k);
    if (u) u.value = v;
  }
}
