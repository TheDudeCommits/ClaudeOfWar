import * as THREE from 'three';

const loader = new THREE.TextureLoader();
const cache = new Map();

function tex(url, { srgb = false, repeat = 1 } = {}) {
  const key = url + srgb + repeat;
  if (cache.has(key)) return cache.get(key);
  const t = loader.load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.setScalar(repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

/**
 * Detail-normal overlay. Tiling PBR maps read as mush at close range because the
 * texel density collapses; a high-frequency normal layered on top restores the
 * micro-surface that makes stone look like stone at 1.5 m. ART_BIBLE §7.
 */
function injectDetailNormal(mat, detailMap, scale, strength) {
  mat.userData.detailScale = { value: scale };
  mat.userData.detailStrength = { value: strength };
  mat.userData.detailMap = { value: detailMap };
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.detailMap = mat.userData.detailMap;
    shader.uniforms.detailScale = mat.userData.detailScale;
    shader.uniforms.detailStrength = mat.userData.detailStrength;
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D detailMap;
        uniform float detailScale;
        uniform float detailStrength;`)
      // Replace the chunk rather than appending to it, so the detail normal is
      // summed in tangent space before the TBN transform. In three r185 `tbn`
      // is always defined under USE_NORMALMAP_TANGENTSPACE — from vTangent when
      // the geometry has tangents, otherwise from a derivative-based frame.
      .replace('#include <normal_fragment_maps>', `
        #ifdef USE_NORMALMAP_TANGENTSPACE
          vec3 mapN = texture2D( normalMap, vNormalMapUv ).xyz * 2.0 - 1.0;
          vec3 detN = texture2D( detailMap, vNormalMapUv * detailScale ).xyz * 2.0 - 1.0;
          mapN.xy += detN.xy * detailStrength;
          mapN.xy *= normalScale;
          normal = normalize( tbn * mapN );
        #endif`);
  };
  mat.customProgramCacheKey = () => `detail${scale}${strength}`;
}

/** Build a PBR material from the albedo/normal/ORM triplet the bake produced. */
export function pbr(name, {
  base = '/assets/tex/arena', repeat = 1, detail = 14, detailStrength = 0.45,
  roughness = 1, metalness = 1, color = 0xffffff, sheen = 0, extra = {},
} = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color,
    map: tex(`${base}/${name}_albedo.png`, { srgb: true, repeat }),
    normalMap: tex(`${base}/${name}_normal.png`, { repeat }),
    // glTF-standard ORM packing: three pulls .r for AO, .g for roughness and
    // .b for metalness, so one texture serves all three slots.
    aoMap: tex(`${base}/${name}_orm.png`, { repeat }),
    roughnessMap: tex(`${base}/${name}_orm.png`, { repeat }),
    metalnessMap: tex(`${base}/${name}_orm.png`, { repeat }),
    roughness, metalness,
    normalScale: new THREE.Vector2(1, 1),
    envMapIntensity: 1.0,
    ...extra,
  });
  // The bake wrote AO into UV0, not a second channel.
  mat.aoMap.channel = 0;
  mat.aoMapIntensity = 0.85;
  if (sheen > 0) { mat.sheen = sheen; mat.sheenRoughness = 0.75; }
  if (detail > 0) {
    injectDetailNormal(mat, tex('/assets/tex/arena/detail_normal.png'), detail, detailStrength);
  }
  return mat;
}

/**
 * Surface table. Roughness/metalness come from the ORM maps; the multipliers
 * here only trim them. Constant roughness is an automatic fail (ART_BIBLE §12),
 * so every entry keeps its map.
 */
export const SURFACES = {
  stone:  () => pbr('stone',  { repeat: 3, detail: 18, detailStrength: 0.5 }),
  rock:   () => pbr('rock',   { repeat: 2, detail: 16, detailStrength: 0.55 }),
  ground: () => pbr('rock',   { repeat: 8, detail: 22, detailStrength: 0.5 }),
  dirt:   () => pbr('dirt',   { repeat: 6, detail: 20, detailStrength: 0.45 }),
  snow:   () => pbr('snow',   { repeat: 5, detail: 26, detailStrength: 0.3,
            extra: { color: 0xf2f6ff } }),
  timber: () => pbr('timber', { repeat: 2, detail: 12, detailStrength: 0.4 }),
  plank:  () => pbr('plank',  { repeat: 2, detail: 12, detailStrength: 0.4 }),
  bark:   () => pbr('bark',   { repeat: 3, detail: 14, detailStrength: 0.6 }),
  iron:   () => pbr('iron',   { repeat: 2, detail: 10, detailStrength: 0.35 }),
  rope:   () => pbr('rope',   { repeat: 4, detail: 8,  detailStrength: 0.5 }),
  cloth:  () => pbr('cloth',  { repeat: 3, detail: 10, detailStrength: 0.3, sheen: 0.6 }),
  thatch: () => pbr('thatch', { repeat: 4, detail: 14, detailStrength: 0.55 }),
};

export function surface(name) {
  const f = SURFACES[name];
  if (!f) throw new Error('no surface: ' + name);
  if (!cache.has('mat:' + name)) cache.set('mat:' + name, f());
  return cache.get('mat:' + name);
}
