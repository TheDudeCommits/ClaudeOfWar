import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, DepthOfFieldEffect,
  ToneMappingEffect, ToneMappingMode, BlendFunction, KernelSize,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { GradeEffect, ExposureEffect } from './grade.js';

/**
 * Quality presets. Measured on the target machine — a fanless MacBook Air M2,
 * 8GB — at 1920x1080. That machine throttles hard under sustained GPU load, so
 * both a cold and a warm figure are quoted; the warm one is what a player
 * actually sees after a few minutes.
 *
 *   high    native res, 4x MSAA          ~16 fps cold
 *   medium  0.75 scale, 2x MSAA          ~27 fps cold
 *   low     0.60 scale, no MSAA, no AO   ~37 fps cold / ~20 warm
 *
 * `low` is the default because the 30 FPS floor is a requirement, not a target.
 */
export const PRESETS = {
  // MSAA is dropped at every level. Measured here, 2x MSAA on a half-float
  // target cost 4.5x the frame time (56 fps -> 12 fps) for edge quality that
  // bloom, grain and the sub-native upscale largely hide anyway. Resolution
  // scale is the dial instead.
  high:   { scale: 1.00, msaa: 0, ao: true,  dofScale: 0.5,
            bloomKernel: KernelSize.LARGE,  shadow: 2048 },
  medium: { scale: 0.80, msaa: 0, ao: true,  dofScale: 0.5,
            bloomKernel: KernelSize.LARGE,  shadow: 2048 },
  low:    { scale: 0.60, msaa: 0, ao: false, dofScale: 0.35,
            bloomKernel: KernelSize.MEDIUM, shadow: 1024 },
};

const _q = new URLSearchParams(location.search).get('q');
export const QUALITY = PRESETS[_q] || PRESETS.low;
export const RENDER_SCALE = QUALITY.scale;

/**
 * The full ClaudeOfWar look. Effect order follows ART_BIBLE §4 — AO and bloom
 * operate in HDR before the tonemap, grade/CA/grain/vignette after it, and
 * antialiasing last so it isn't re-aliased by later effects.
 */
export function createRenderer(canvas) {
  const renderer = new THREE.WebGLRenderer({
    canvas, antialias: false, powerPreference: 'high-performance',
    stencil: false, depth: false,
  });
  // The Air is a 2x Retina panel, so an uncapped ratio renders 4x the pixels.
  // RENDER_SCALE is the primary quality/perf dial; the post chain's bloom, DOF
  // and grain hide most of the resolution loss.
  const q = new URLSearchParams(location.search).get('scale');
  renderer.setPixelRatio(q ? Number(q) : RENDER_SCALE);
  // postprocessing owns tonemapping; leaving it on here would apply ACES twice.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  // VSM measured 27.8ms of a 90ms frame on an M2 Air: it renders depth then
  // runs two separable blur passes over the whole shadow map every frame. PCF
  // filters in the lighting shader instead — one depth pass, no blur.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  return renderer;
}

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.camera = camera;

    // MSAA replaces SMAA, which cost 57ms of a 110ms frame here. 4x on a
    // half-float target is NOT free even on Apple tile memory — it multiplies
    // the bandwidth of every HDR pixel — so this is a quality dial, not a
    // constant.
    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,  // HDR through the chain
      multisampling: QUALITY.msaa,
    });
    this.composer.addPass(new RenderPass(scene, camera));

    // N8AO resolves far more convincingly than three's built-in SSAO, and
    // contact shadow quality is a large part of the "expensive" read.
    this.ao = new N8AOPostPass(scene, camera,
      renderer.domElement.width, renderer.domElement.height);
    this.ao.configuration.aoRadius = 1.6;
    this.ao.configuration.distanceFalloff = 1.0;
    this.ao.configuration.intensity = 3.2;
    this.ao.configuration.color = new THREE.Color(0x0a1220);
    // Half-res AO with a cheaper denoise: 30ms -> ~8ms. AO is low-frequency
    // by nature, so the resolution loss is invisible next to the frame cost.
    this.ao.configuration.halfRes = true;
    this.ao.enabled = QUALITY.ao;
    this.ao.configuration.denoiseSamples = 4;
    this.ao.configuration.denoiseRadius = 6;
    this.composer.addPass(this.ao);

    this.bloom = new BloomEffect({
      blendFunction: BlendFunction.ADD,
      luminanceThreshold: 0.72,
      luminanceSmoothing: 0.32,
      intensity: 1.15,
      kernelSize: QUALITY.bloomKernel,
      mipmapBlur: true,
      radius: 0.72,
    });

    this.exposure = new ExposureEffect(0.55);

    // Focus sits on the combat plane; the hero shoulder blurs slightly near and
    // the background falls off hard. ART_BIBLE §6.
    // focusRange is normalised depth, so it is brutally sensitive — too tight
    // and the blur swallows the hero along with the background.
    this.dof = new DepthOfFieldEffect(camera, {
      focusDistance: 0.02,
      focalLength: 0.02,
      focusRange: 0.035,
      bokehScale: 2.6,
      resolutionScale: QUALITY.dofScale,
    });
    // Setting `target` makes the effect derive focusDistance itself each update,
    // which is the only reliable way to focus on a moving world-space point.
    this.dof.target = new THREE.Vector3(0, 1.2, 0);

    this.tonemap = new ToneMappingEffect({
      mode: ToneMappingMode.ACES_FILMIC,
      resolution: 256,
      whitePoint: 6.0,
      middleGrey: 0.42,
      adaptive: false,
    });

    this.grade = new GradeEffect();




    // HDR-domain effects, then the tonemap, then LDR finishing.
    // Chromatic aberration is a convolution effect and cannot share a pass.
    // Two passes total. GradeEffect must be alone in the second one: it samples
    // `inputBuffer` for chromatic aberration and needs that to be the tonemapped
    // result, not an intermediate stage of a merged pass.
    this.composer.addPass(new EffectPass(
      camera, this.exposure, this.bloom, this.dof, this.tonemap));
    this.composer.addPass(new EffectPass(camera, this.grade));
  }

  setSize(w, h) {
    this.composer.setSize(w, h);
    this.ao.setSize(w, h);
  }

  /** Focus the DOF on a world point (the lock-on target during combat). */
  focusOn(worldPos) {
    this.dof.target.copy(worldPos);
  }

  render(dt) { this.composer.render(dt); }
}

/** Time-of-day presets. ART_BIBLE §3. */
export const TOD = {
  cold_overcast: {
    // Backlit from 205 deg: the arena is walled by tall rock, so a low sun from
    // any other bearing leaves the whole play floor in shade. This bearing rakes
    // the floor and throws long shadows toward camera.
    sun: { color: 0xffe3c0, intensity: 4.6, elevation: 20, azimuth: 205 },
    fill: { color: 0x5a6e88, intensity: 0.30 },
    rim: { color: 0xbcd4f0, intensity: 1.25 },
    sky: { turbidity: 7.5, rayleigh: 2.6, mieCoefficient: 0.006, mieG: 0.72 },
    fog: { color: 0x8fa4b8, density: 0.030 },
    env: 0.38,
    grade: {
      shadowTint: new THREE.Vector3(-0.020, -0.002, 0.040),
      highTint: new THREE.Vector3(0.040, 0.018, -0.016),
      contrast: 1.14, saturation: 0.88, lift: 0.022,
    },
    bloom: 1.05,
  },
  ember_hellscape: {
    sun: { color: 0xff7a2e, intensity: 4.0, elevation: 12, azimuth: 212 },
    fill: { color: 0x7a3d8f, intensity: 1.15 },
    rim: { color: 0xff9a4a, intensity: 3.1 },
    sky: { turbidity: 14, rayleigh: 1.1, mieCoefficient: 0.03, mieG: 0.86 },
    fog: { color: 0x4a2338, density: 0.045 },
    env: 0.40,
    grade: {
      shadowTint: new THREE.Vector3(0.020, -0.008, 0.028),
      highTint: new THREE.Vector3(0.060, 0.014, -0.030),
      contrast: 1.20, saturation: 0.96, lift: 0.026,
    },
    bloom: 1.5,
  },
};
