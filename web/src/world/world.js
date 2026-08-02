import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { TOD, QUALITY } from '../core/rendering.js';

/**
 * Sky, sun, fill/rim lights, fog and image-based lighting.
 *
 * IBL does the job SDFGI did in the Godot build: without an environment map the
 * shadow side of every object goes dead flat and the frame reads as a toy. The
 * sky is rendered into a PMREM cubemap so ambient light actually carries the
 * sky's colour gradient.
 */
export class World {
  constructor(scene, renderer) {
    this.scene = scene;
    this.renderer = renderer;
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.pmrem.compileEquirectangularShader();

    this.sky = new Sky();
    this.sky.scale.setScalar(45000);
    scene.add(this.sky);

    this.sun = new THREE.DirectionalLight(0xffffff, 4);
    this.sun.castShadow = true;
    const s = this.sun.shadow;
    s.mapSize.set(QUALITY.shadow, QUALITY.shadow);
    // The sun sits 60 units out, so the shadow volume only needs to bracket
    // that. VSM stores depth variance and loses all contrast when the near/far
    // range is wide — a 0.5→120 range washes shadows out entirely.
    s.camera.near = 30;
    s.camera.far = 95;
    s.camera.left = -26; s.camera.right = 26;
    s.camera.top = 26; s.camera.bottom = -26;
    // Tuned against raking low-sun geometry: too little bias gives acne on the
    // snow, too much detaches contact shadows from the debris.
    s.bias = -0.0004;
    s.normalBias = 0.022;
    s.radius = 1.6;
    s.blurSamples = 6;
    scene.add(this.sun);
    scene.add(this.sun.target);

    // Cool bounce standing in for sky-dome fill.
    this.fill = new THREE.HemisphereLight(0x8fa4b8, 0x2b2620, 0.28);
    scene.add(this.fill);

    // Dedicated back/rim light: ART_BIBLE §3 requires the hero always be
    // separated from the background by a rim.
    this.rim = new THREE.DirectionalLight(0xbcd4f0, 2.2);
    scene.add(this.rim);
    scene.add(this.rim.target);

    this.applyTOD('cold_overcast');
  }

  applyTOD(name) {
    const p = TOD[name];
    if (!p) throw new Error('unknown time of day: ' + name);
    this.preset = p;
    this.todName = name;

    const u = this.sky.material.uniforms;
    u.turbidity.value = p.sky.turbidity;
    u.rayleigh.value = p.sky.rayleigh;
    u.mieCoefficient.value = p.sky.mieCoefficient;
    u.mieDirectionalG.value = p.sky.mieG;

    const phi = THREE.MathUtils.degToRad(90 - p.sun.elevation);
    const theta = THREE.MathUtils.degToRad(p.sun.azimuth);
    const dir = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
    u.sunPosition.value.copy(dir);

    this.sun.position.copy(dir).multiplyScalar(60);
    this.sun.target.position.set(0, 0, 0);
    this.sun.color.setHex(p.sun.color);
    this.sun.intensity = p.sun.intensity;

    // Rim sits roughly opposite the key, slightly above the horizon.
    this.rim.position.copy(dir).multiplyScalar(-45).setY(18);
    this.rim.target.position.set(0, 1.2, 0);
    this.rim.color.setHex(p.rim.color);
    this.rim.intensity = p.rim.intensity;

    this.fill.color.setHex(p.fill.color);
    this.fill.intensity = p.fill.intensity;

    this.scene.fog = new THREE.FogExp2(p.fog.color, p.fog.density);

    this.refreshEnvironment();
    return p;
  }

  /** Re-bake IBL from the current sky. Call after any sky/TOD change. */
  refreshEnvironment() {
    if (this.envRT) this.envRT.dispose();
    this.envRT = this.pmrem.fromScene(this.sky, 0.04);
    this.scene.environment = this.envRT.texture;
    this.scene.environmentIntensity = this.preset.env;
    this.scene.background = this.envRT.texture;
    this.scene.backgroundIntensity = this.preset.env * 0.95;
  }

  /** Keep the shadow frustum centred on the action so texels aren't wasted. */
  followShadow(target) {
    const d = this.sun.position.clone().normalize().multiplyScalar(60);
    this.sun.position.copy(target).add(d);
    this.sun.target.position.copy(target);
    this.sun.target.updateMatrixWorld();
  }
}
