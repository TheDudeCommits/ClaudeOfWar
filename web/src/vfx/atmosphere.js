import * as THREE from 'three';
import { asset } from '../core/paths.js';

/**
 * Ambient airborne particles — snow, ash, embers.
 *
 * ART_BIBLE §10 / §12.6: empty air is an instant fail. The reference plates are
 * never clean; Gow5.jpg carries ~80 readable flakes at four different scales and
 * they are *lit* — near-white where they sit between the camera and the sun,
 * grey where they don't. That directional response is the whole difference
 * between "weather" and "dirt on the lens".
 *
 * Design notes, several of which are load-bearing:
 *
 *  1. ONE `THREE.Points`. 600 Sprites would be 600 draw calls.
 *  2. Motion runs entirely in the vertex shader against a camera-anchored box,
 *     so there is no per-frame CPU cost and particles can never run out: one
 *     that leaves the box wraps back in through the opposite face.
 *  3. Depth is stratified into nested shells (see LAYERS). Equal-ish counts in
 *     three boxes of growing size puts most particles near the lens where they
 *     are large and DOF-soft, and thins them out to ~30 m where they are
 *     sub-pixel and fogged. That gradient is what reads as volume — a single
 *     uniform box reads as a flat curtain.
 *  4. Lighting is a Henyey-Greenstein forward-scatter lobe about the sun
 *     direction. Ice and ash forward-scatter hard (g ≈ 0.6–0.8), which is why
 *     backlit snow blows out and front-lit snow is dull grey.
 *  5. Fog is applied in-shader from the scene's own FogExp2 values. Skip it and
 *     the particles sit in front of the aerial perspective, flattening the
 *     frame (ART_BIBLE §12.4).
 *
 * Soft-particle depth fade: the composer owns the only depth buffer and reading
 * it from a material inside the same render pass is a feedback loop, so this
 * uses the sanctioned fallback — a near-plane fade, a per-shell radial fade, a
 * sub-pixel fade, and sprite alpha profiles feathered enough (gen_sprites.py)
 * that an intersection with geometry never resolves as a hard line.
 */

/* Nested depth shells. `half` is metres from the camera anchor, `share` the
 * fraction of the particle budget living in that shell. */
const LAYERS = [
  { half: [3.2, 2.4, 3.2], share: 0.34, size: 1.00 },
  { half: [9.0, 5.5, 9.0], share: 0.36, size: 0.88 },
  { half: [22.0, 11.0, 22.0], share: 0.30, size: 0.80 },
];

export const ATMOSPHERE_PRESETS = {
  /** Cold overcast ruin: dry snow, wind-driven, catching the low raking sun. */
  snow: {
    count: 640,
    texture: '/assets/vfx/flake_atlas.webp',
    additive: false,
    sizeBase: 0.034,          // world-space sprite diameter, metres
    sizeVariance: 0.9,
    wind: new THREE.Vector3(0.62, -0.46, 0.16),
    windGust: 0.45,
    turbulence: 0.75,
    turbFreq: 0.30,
    spin: 0.9,
    // Backlit ice pushes past 1.0 and blooms; the shadow side stays cool grey.
    sunGain: 3.2,
    sunPhaseG: 0.70,
    ambientGain: 0.26,
    ambientColor: new THREE.Color(0x9fb6cf),
    opacity: 0.95,
    fogTint: 1.0,             // snow takes the fog colour with distance
    fogFade: 0.80,
    flicker: 0.0,
  },
  /** Ember hellscape: rising cinders, additive, deep into HDR so bloom bites. */
  ember: {
    count: 520,
    texture: '/assets/vfx/ember_atlas.webp',
    additive: true,
    sizeBase: 0.028,
    sizeVariance: 1.15,
    wind: new THREE.Vector3(0.34, 0.66, -0.12),
    windGust: 0.70,
    turbulence: 1.10,
    turbFreq: 0.50,
    spin: 0.35,
    sunGain: 1.8,
    sunPhaseG: 0.45,
    // Embers are their own light source, so the "ambient" term IS the ember
    // glow, pushed well past the 0.72 bloom threshold on every particle.
    ambientGain: 4.6,
    ambientColor: new THREE.Color(0xff7a28),
    opacity: 1.0,
    fogTint: 0.0,             // additive: fog must attenuate, never tint
    fogFade: 1.0,
    flicker: 0.55,
  },
};

const VERTEX = /* glsl */`
uniform float uTime;
uniform vec3  uAnchor;        // camera position, quantised
uniform vec3  uWind;
uniform float uWindGust;
uniform float uTurb;
uniform float uTurbFreq;
uniform float uSpin;
uniform float uSizeBase;
uniform float uPixelScale;    // viewportHeightPx * 0.5 / tan(fovY * 0.5)
uniform vec3  uSunDir;        // normalised, points FROM the scene TOWARD the sun
uniform vec3  uSunColor;
uniform vec3  uAmbColor;
uniform float uSunGain;
uniform float uAmbGain;
uniform float uPhaseG;
uniform float uFlicker;
uniform float uOpacity;
uniform float uNearFade;      // metres; anything closer fades out

attribute vec3  aCell;        // seed position inside the shell box, [0,1)
attribute vec4  aRand;        // x size, y speed, z phase, w atlas index
attribute vec4  aLayer;       // xyz half extents, w spare
attribute float aSizeMul;

varying vec4  vColor;
varying float vRot;
varying vec2  vAtlas;
varying float vDepth;

/* Divergence-light swirl. Three decorrelated sine octaves per axis read as curl
 * noise at this scale for a fraction of the cost of real 3D noise. Sampled in
 * world space so the field is anchored to the arena, not to the camera. */
vec3 swirl(vec3 p, float t) {
  vec3 a = p * 0.35 + t;
  vec3 b = p * 0.11 - t * 0.63;
  return vec3(
    sin(a.y) * cos(b.z) + 0.45 * sin(b.y * 2.7 + a.x),
    sin(a.z * 0.8) * cos(b.x) * 0.55 + 0.30 * sin(b.z * 2.1),
    sin(a.x) * cos(b.y) + 0.45 * sin(b.x * 2.3 + a.z));
}

/* Henyey-Greenstein phase function. */
float hg(float cosT, float g) {
  float g2 = g * g;
  float d = 1.0 + g2 - 2.0 * g * cosT;
  return (1.0 - g2) / (4.0 * 3.14159265 * pow(max(d, 1e-4), 1.5));
}

void main() {
  vec3 halfBox = aLayer.xyz;
  vec3 span = halfBox * 2.0;
  float t = uTime;
  float speed = 0.55 + aRand.y * 1.1;

  vec3 p = aCell * span - halfBox;
  // Gusting: the field surges and eases instead of sliding at a constant rate.
  // Linear fall is the classic tell of a cheap snow system.
  p += uWind * (t * speed + uWindGust * sin(t * 0.21 + aRand.z * 6.283) * 2.2);
  p = mod(p + halfBox, span) - halfBox;

  vec3 world = p + uAnchor;
  p += swirl(world * 0.5 + aRand.z * 11.0, t * uTurbFreq) * uTurb * (0.6 + aRand.x);
  p = mod(p + halfBox, span) - halfBox;
  world = p + uAnchor;

  vec4 mv = modelViewMatrix * vec4(world, 1.0);
  float dist = -mv.z;
  gl_Position = projectionMatrix * mv;

  float diameter = uSizeBase * (0.45 + aRand.x * 1.05) * aSizeMul;
  float psize = max(1.0, diameter * uPixelScale / max(dist, 0.05));
  gl_PointSize = psize;

  /* ---- lighting ---- */
  vec3 V = normalize(world - cameraPosition);
  // Forward scatter: light travelling along -uSunDir keeps going toward the
  // camera when the particle sits between the two, i.e. when V faces the sun.
  float cosT = dot(V, uSunDir);
  float phase = hg(cosT, uPhaseG) * 4.0;
  // Grazing rim: even well off-axis, a thin ice plate picks up an edge glow.
  float graze = pow(max(cosT * 0.5 + 0.5, 0.0), 3.0);

  float flick = 1.0 + uFlicker * sin(t * (5.0 + aRand.y * 9.0) + aRand.z * 20.0);

  vec3 col = uSunColor * uSunGain * (phase + graze * 0.35)
           + uAmbColor * uAmbGain * flick;

  /* ---- fades (see header: this is the soft-particle fallback) ---- */
  float a = uOpacity;
  a *= smoothstep(uNearFade * 0.3, uNearFade, dist);
  // Shell boundary: fade the outer fifth so the wrap never pops.
  float radial = length(vec3(p.x, p.y * (halfBox.x / max(halfBox.y, 1e-3)), p.z));
  a *= 1.0 - smoothstep(halfBox.x * 0.80, halfBox.x * 1.05, radial);
  // Sub-pixel sprites scintillate into white noise; fade rather than alias.
  a *= smoothstep(0.7, 1.9, psize);

  vColor = vec4(col, a);
  vDepth = dist;
  vRot = aRand.z * 6.283185 + t * uSpin * (aRand.y - 0.5) * 3.0;
  vAtlas = vec2(mod(aRand.w, 2.0), floor(aRand.w * 0.5)) * 0.5;
}
`;

const FRAGMENT = /* glsl */`
uniform sampler2D uMap;
uniform vec3  uFogColor;
uniform float uFogDensity;
uniform float uFogTint;
uniform float uFogFade;
uniform float uAdditive;

varying vec4  vColor;
varying float vRot;
varying vec2  vAtlas;
varying float vDepth;

void main() {
  // Point sprites cannot rotate, so rotate the lookup instead. Without this a
  // field of identically-oriented crystals reads as a repeating stamp.
  vec2 c = gl_PointCoord - 0.5;
  float s = sin(vRot), co = cos(vRot);
  vec2 r = vec2(c.x * co - c.y * s, c.x * s + c.y * co) + 0.5;
  if (r.x < 0.0 || r.x > 1.0 || r.y < 0.0 || r.y > 1.0) discard;

  // Inset half a texel of the 128 px cell so bilinear taps cannot reach across
  // the atlas gutter into a neighbouring sprite.
  vec4 tex = texture2D(uMap, vAtlas + r * (0.5 * 127.0 / 128.0) + 0.5 / 256.0);

  float alpha = tex.a * vColor.a;
  if (alpha < 0.004) discard;

  vec3 col = vColor.rgb * tex.rgb;

  // FogExp2, matched to the scene, so particles share the aerial perspective
  // instead of floating in front of it.
  float fd = uFogDensity * vDepth;
  float f = 1.0 - exp(-fd * fd);
  col = mix(col, uFogColor, f * uFogTint);
  alpha *= 1.0 - f * uFogFade;

  // Premultiplied for the opaque preset — that is what lets an HDR colour
  // survive the blend, where a plain SrcAlpha blend would clamp it. Embers go
  // straight additive and write no alpha.
  gl_FragColor = vec4(col * alpha, alpha * (1.0 - uAdditive));
}
`;

/**
 * @param {THREE.Scene} scene
 * @param {object} opts
 *   preset      'snow' | 'ember'                      (default 'snow')
 *   count       override the preset's particle count
 *   sun         THREE.DirectionalLight to track       (strongly recommended)
 *   renderer    THREE.WebGLRenderer — read-only, for the drawing-buffer height
 *   nearFade    metres; particles nearer than this fade out (default 0.9)
 * @returns {{
 *   update(dt:number, camera:THREE.Camera):void,
 *   setPreset(name:string):void,
 *   dispose():void,
 *   points:THREE.Points, material:THREE.ShaderMaterial, uniforms:object }}
 */
export function createAtmosphere(scene, opts = {}) {
  let presetName = opts.preset || 'snow';
  const preset = { ...ATMOSPHERE_PRESETS[presetName], ...(opts.overrides || {}) };
  const count = opts.count || preset.count;

  const geo = new THREE.BufferGeometry();
  const cell = new Float32Array(count * 3);
  const rand = new Float32Array(count * 4);
  const layer = new Float32Array(count * 4);
  const sizeMul = new Float32Array(count);
  // `position` is never read by the shader — everything derives from aCell —
  // but three needs the attribute present to size the draw call.
  const position = new Float32Array(count * 3);

  let idx = 0;
  LAYERS.forEach((L, li) => {
    const n = li === LAYERS.length - 1 ? count - idx : Math.round(count * L.share);
    for (let i = 0; i < n && idx < count; i++, idx++) {
      cell[idx * 3] = Math.random();
      cell[idx * 3 + 1] = Math.random();
      cell[idx * 3 + 2] = Math.random();
      rand[idx * 4] = Math.pow(Math.random(), 1.6) * preset.sizeVariance;
      rand[idx * 4 + 1] = Math.random();
      rand[idx * 4 + 2] = Math.random();
      // Bias the atlas draw by shell: near particles get the readable crystal
      // and disc shapes, far ones get the sub-pixel speck.
      const roll = Math.random();
      rand[idx * 4 + 3] = li === 0
        ? (roll < 0.45 ? 0 : roll < 0.82 ? 1 : 2)
        : li === 1
          ? (roll < 0.24 ? 0 : roll < 0.54 ? 1 : roll < 0.78 ? 2 : 3)
          : (roll < 0.62 ? 3 : roll < 0.86 ? 1 : 2);
      layer[idx * 4] = L.half[0];
      layer[idx * 4 + 1] = L.half[1];
      layer[idx * 4 + 2] = L.half[2];
      layer[idx * 4 + 3] = 0;
      sizeMul[idx] = L.size;
    }
  });

  geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geo.setAttribute('aCell', new THREE.BufferAttribute(cell, 3));
  geo.setAttribute('aRand', new THREE.BufferAttribute(rand, 4));
  geo.setAttribute('aLayer', new THREE.BufferAttribute(layer, 4));
  geo.setAttribute('aSizeMul', new THREE.BufferAttribute(sizeMul, 1));
  // The shader relocates every vertex, so three's culling maths is meaningless.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  const loader = new THREE.TextureLoader();
  function loadAtlas(url) {
    const t = loader.load(asset(url));
    t.colorSpace = THREE.SRGBColorSpace;
    // flipY off keeps the atlas cell order identical to gen_sprites.py, so the
    // per-shell sprite bias above actually selects the sprite it names.
    t.flipY = false;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = true;
    t.anisotropy = 1;
    return t;
  }

  const uniforms = {
    uTime: { value: 0 },
    uAnchor: { value: new THREE.Vector3() },
    uWind: { value: preset.wind.clone() },
    uWindGust: { value: preset.windGust },
    uTurb: { value: preset.turbulence },
    uTurbFreq: { value: preset.turbFreq },
    uSpin: { value: preset.spin },
    uSizeBase: { value: preset.sizeBase },
    uPixelScale: { value: 1000 },
    uSunDir: { value: new THREE.Vector3(-0.4, 0.34, -0.85).normalize() },
    uSunColor: { value: new THREE.Color(0xffe3c0) },
    uAmbColor: { value: preset.ambientColor.clone() },
    uSunGain: { value: preset.sunGain },
    uAmbGain: { value: preset.ambientGain },
    uPhaseG: { value: preset.sunPhaseG },
    uFlicker: { value: preset.flicker },
    uOpacity: { value: preset.opacity },
    uNearFade: { value: opts.nearFade ?? 0.9 },
    uMap: { value: loadAtlas(preset.texture) },
    uFogColor: { value: new THREE.Color(0x8fa4b8) },
    uFogDensity: { value: 0.03 },
    uFogTint: { value: preset.fogTint },
    uFogFade: { value: preset.fogFade },
    uAdditive: { value: preset.additive ? 1 : 0 },
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: true,
    depthTest: true,
    depthWrite: false,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: preset.additive ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor,
    blendEquation: THREE.AddEquation,
    blendSrcAlpha: THREE.OneFactor,
    blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    // The composer tonemaps; a second ACES pass here would wash the flakes out.
    toneMapped: false,
  });

  const points = new THREE.Points(geo, material);
  points.frustumCulled = false;
  points.renderOrder = opts.renderOrder ?? 10;
  points.name = 'atmosphere';
  scene.add(points);

  const renderer = opts.renderer || null;
  const sun = opts.sun || null;
  const baseSunGain = { value: preset.sunGain };
  let time = Math.random() * 400;

  // Quantising the anchor stops the wrap seam crawling across frame as the
  // camera dollies.
  const QUANT = 0.5;

  function syncEnvironment(camera) {
    if (sun) {
      uniforms.uSunDir.value.copy(sun.position).sub(sun.target.position).normalize();
      uniforms.uSunColor.value.copy(sun.color);
      uniforms.uSunGain.value =
        baseSunGain.value * Math.min(sun.intensity / 4.6, 1.6);
    }
    const fog = scene.fog;
    if (fog && fog.isFogExp2) {
      uniforms.uFogColor.value.copy(fog.color);
      uniforms.uFogDensity.value = fog.density;
    }
    const h = renderer
      ? renderer.domElement.height
      : (typeof innerHeight === 'number'
        ? innerHeight * Math.min(devicePixelRatio || 1, 2) : 1080);
    // gl_PointSize is device pixels; this converts a world-space diameter at
    // one metre into that space for the current lens and viewport.
    uniforms.uPixelScale.value = h * 0.5 * camera.projectionMatrix.elements[5];
  }

  const api = {
    points,
    material,
    uniforms,
    get preset() { return presetName; },

    update(dt, camera) {
      time += dt;
      uniforms.uTime.value = time;
      if (!camera) return;
      uniforms.uAnchor.value.set(
        Math.round(camera.position.x / QUANT) * QUANT,
        Math.round(camera.position.y / QUANT) * QUANT,
        Math.round(camera.position.z / QUANT) * QUANT);
      syncEnvironment(camera);
    },

    /** Hot-swap the look when the time of day changes. */
    setPreset(name) {
      const p = ATMOSPHERE_PRESETS[name];
      if (!p) return;
      Object.assign(preset, p);
      uniforms.uWind.value.copy(p.wind);
      uniforms.uWindGust.value = p.windGust;
      uniforms.uTurb.value = p.turbulence;
      uniforms.uTurbFreq.value = p.turbFreq;
      uniforms.uSpin.value = p.spin;
      uniforms.uSizeBase.value = p.sizeBase;
      uniforms.uAmbColor.value.copy(p.ambientColor);
      uniforms.uAmbGain.value = p.ambientGain;
      uniforms.uPhaseG.value = p.sunPhaseG;
      uniforms.uFlicker.value = p.flicker;
      uniforms.uOpacity.value = p.opacity;
      uniforms.uFogTint.value = p.fogTint;
      uniforms.uFogFade.value = p.fogFade;
      uniforms.uAdditive.value = p.additive ? 1 : 0;
      baseSunGain.value = p.sunGain;
      uniforms.uSunGain.value = p.sunGain;
      uniforms.uMap.value.dispose();
      uniforms.uMap.value = loadAtlas(p.texture);
      material.blendDst = p.additive
        ? THREE.OneFactor : THREE.OneMinusSrcAlphaFactor;
      material.needsUpdate = true;
      presetName = name;
    },

    dispose() {
      scene.remove(points);
      geo.dispose();
      material.dispose();
      uniforms.uMap.value.dispose();
    },
  };
  return api;
}

/** The atmosphere preset that matches a TOD name from core/rendering.js. */
export function atmosphereForTOD(todName) {
  return todName === 'ember_hellscape' ? 'ember' : 'snow';
}
