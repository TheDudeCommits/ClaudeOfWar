import * as THREE from 'three';

/**
 * One combined shader modification covering macro breakup, roughness remap,
 * wetness zoning and the detail normal.
 *
 * They share a single `onBeforeCompile` on purpose: two separate injections
 * would each want their own `customProgramCacheKey`, and three would then
 * compile — or worse, silently reuse — the wrong program.
 *
 * r185 note: `perturbNormal2Arb` no longer exists. Inside
 * `#include <normal_fragment_maps>` the only valid path is `tbn`, which is
 * always defined under USE_NORMALMAP_TANGENTSPACE (from vTangent when the
 * geometry has tangents, from a derivative frame otherwise). Referencing the
 * old function produced 261 silent compile errors here — materials merely
 * looked flat, nothing visibly broke.
 */
export function injectSurfaceShader(mat, opts) {
  const {
    macroMap, detailMap, detailScale = 14, detailStrength = 0.45,
    macroScale, macroAlbedo, macroRough, roughRemap, wetThreshold,
    wetRough, wetDarken,
  } = opts;

  const u = {
    macroMap: { value: macroMap },
    macroScale: { value: macroScale },
    macroAlbedo: { value: new THREE.Vector2(macroAlbedo[0], macroAlbedo[1]) },
    macroRough: { value: macroRough },
    roughRemap: { value: new THREE.Vector2(roughRemap[0], roughRemap[1]) },
    wetThreshold: { value: wetThreshold },
    wetRough: { value: wetRough },
    wetDarken: { value: wetDarken },
  };
  if (detailMap) {
    u.detailMap = { value: detailMap };
    u.detailScale = { value: detailScale };
    u.detailStrength = { value: detailStrength };
  }
  mat.userData.cowUniforms = u;

  const key = [macroScale, macroAlbedo.join('_'), macroRough, roughRemap.join('_'),
    wetThreshold, wetRough, wetDarken, detailMap ? detailScale : 'nd',
    detailMap ? detailStrength : 0].join(':');
  mat.customProgramCacheKey = () => 'cow:' + key;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, u);

    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', `
      #include <common>
      uniform sampler2D macroMap;
      uniform float macroScale;
      uniform vec2 macroAlbedo;
      uniform float macroRough;
      uniform vec2 roughRemap;
      uniform float wetThreshold;
      uniform float wetRough;
      uniform float wetDarken;
      ${detailMap ? `
      uniform sampler2D detailMap;
      uniform float detailScale;
      uniform float detailStrength;` : ''}
    `);
    // NOTE: the sampling is inlined at each use site rather than wrapped in a
    // helper. three emits `#include <common>` BEFORE `<uv_pars_fragment>`, so a
    // function defined up there cannot see `vMapUv` yet — doing so fails with
    // "undeclared identifier" on every material that uses this shader.

    // Albedo: large-scale value breakup, then darken the wet zones.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>', `
      #include <map_fragment>
      {
        float m = texture2D(macroMap, vMapUv * macroScale).r;
        float wet = 1.0 - smoothstep(wetThreshold - 0.10, wetThreshold, m);
        diffuseColor.rgb *= mix(macroAlbedo.x, macroAlbedo.y, m);
        diffuseColor.rgb *= mix(1.0, 1.0 - wetDarken, wet);
      }`);

    // Roughness: remap into a floor..ceiling window (never scale — scaling
    // preserves the map's glossy minimum and the sun mirrors off it), then add
    // macro variation, then drive the wet zones glossy.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <roughnessmap_fragment>', `
      #include <roughnessmap_fragment>
      {
        float m = texture2D(macroMap, vMapUv * macroScale).r;
        float wet = 1.0 - smoothstep(wetThreshold - 0.10, wetThreshold, m);
        roughnessFactor = mix(roughRemap.x, roughRemap.y, clamp(roughnessFactor, 0.0, 1.0));
        roughnessFactor = clamp(roughnessFactor + (m - 0.5) * macroRough, 0.0, 1.0);
        roughnessFactor = mix(roughnessFactor, wetRough, wet);
      }`);

    if (detailMap) {
      shader.fragmentShader = shader.fragmentShader.replace(
        '#include <normal_fragment_maps>', `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
          vec3 detN = texture2D( detailMap, vNormalMapUv * detailScale ).xyz * 2.0 - 1.0;
          mapN.xy += detN.xy * detailStrength;
          mapN.xy *= normalScale;
          normal = normalize( tbn * mapN );
        #endif`);
    }
  };
  return mat;
}
