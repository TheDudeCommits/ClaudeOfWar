import * as THREE from 'three';
import {
  EffectComposer, RenderPass, EffectPass, BloomEffect, DepthOfFieldEffect,
  ChromaticAberrationEffect, NoiseEffect, VignetteEffect, ToneMappingEffect,
  ToneMappingMode, SMAAEffect, BlendFunction, KernelSize,
} from 'postprocessing';
import { N8AOPostPass } from 'n8ao';
import { GradeEffect, ExposureEffect } from './grade.js';

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
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  // postprocessing owns tonemapping; leaving it on here would apply ACES twice.
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap is deprecated in r185 and silently downgrades; VSM
  // honours shadow.radius/blurSamples, which is what gives soft raking shadows.
  renderer.shadowMap.type = THREE.VSMShadowMap;
  return renderer;
}

export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.camera = camera;

    this.composer = new EffectComposer(renderer, {
      frameBufferType: THREE.HalfFloatType,  // HDR through the chain
      multisampling: 0,
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
    this.ao.configuration.halfRes = false;
    this.ao.configuration.denoiseSamples = 8;
    this.ao.configuration.denoiseRadius = 12;
    this.composer.addPass(this.ao);

    this.bloom = new BloomEffect({
      blendFunction: BlendFunction.ADD,
      luminanceThreshold: 0.72,
      luminanceSmoothing: 0.32,
      intensity: 1.15,
      kernelSize: KernelSize.HUGE,
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
      resolutionScale: 1.0,
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

    this.ca = new ChromaticAberrationEffect({
      offset: new THREE.Vector2(0.0011, 0.0011),
      radialModulation: true,
      modulationOffset: 0.28,
    });

    this.grain = new NoiseEffect({
      blendFunction: BlendFunction.OVERLAY,
      premultiply: true,
    });
    this.grain.blendMode.opacity.value = 0.062;

    this.vignette = new VignetteEffect({ offset: 0.28, darkness: 0.62 });

    this.smaa = new SMAAEffect();

    // HDR-domain effects, then the tonemap, then LDR finishing.
    // Chromatic aberration is a convolution effect and cannot share a pass.
    this.composer.addPass(new EffectPass(
      camera, this.exposure, this.bloom, this.dof, this.tonemap));
    this.composer.addPass(new EffectPass(camera, this.grade));
    this.composer.addPass(new EffectPass(camera, this.ca));
    this.composer.addPass(new EffectPass(
      camera, this.grain, this.vignette, this.smaa));
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
