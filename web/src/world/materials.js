import * as THREE from 'three';
import { asset } from '../core/paths.js';
import { SURFACE_PARAMS, DEFAULT_PARAMS } from './mat/params.js';
import { injectSurfaceShader } from './mat/macro.js';

const loader = new THREE.TextureLoader();
const cache = new Map();

function tex(url, { srgb = false, repeat = 1 } = {}) {
  const key = url + srgb + repeat;
  if (cache.has(key)) return cache.get(key);
  const t = loader.load(asset(url));
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.setScalar(repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  cache.set(key, t);
  return t;
}

/** Build a PBR material from the albedo/normal/ORM triplet the bake produced. */
export function pbr(name, {
  base = '/assets/tex/arena', repeat = 1, detail = 14, detailStrength = 0.45,
  roughness = 1, metalness = 1, color = 0xffffff, sheen = 0,
  env = 0.82, ao = 1.0, macro = {}, extra = {},
} = {}) {
  const mat = new THREE.MeshStandardMaterial({
    color,
    map: tex(`${base}/${name}_albedo.webp`, { srgb: true, repeat }),
    normalMap: tex(`${base}/${name}_normal.webp`, { repeat }),
    // glTF-standard ORM packing: three pulls .r for AO, .g for roughness and
    // .b for metalness, so one texture serves all three slots.
    aoMap: tex(`${base}/${name}_orm.webp`, { repeat }),
    roughnessMap: tex(`${base}/${name}_orm.webp`, { repeat }),
    metalnessMap: tex(`${base}/${name}_orm.webp`, { repeat }),
    roughness, metalness,
    normalScale: new THREE.Vector2(1, 1),
    // Indirect light is the only thing lifting shadowed stone off the floor of
    // the histogram; at 1.0 the frame measured a 0.109 black point with no deep
    // shadow anywhere. Trimming env on the environment (not the hero) buys the
    // contrast back without crushing anything to zero.
    envMapIntensity: env,
    ...extra,
  });
  // The bake wrote AO into UV0, not a second channel.
  mat.aoMap.channel = 0;
  mat.aoMapIntensity = ao;
  if (sheen > 0) { mat.sheen = sheen; mat.sheenRoughness = 0.75; }

  injectSurfaceShader(mat, {
    macroMap: tex('/assets/tex/arena/macro_variation.webp'),
    detailMap: detail > 0 ? tex('/assets/tex/arena/detail_normal.webp') : null,
    detailScale: detail, detailStrength,
    ...DEFAULT_PARAMS, ...macro,
  });
  return mat;
}

/**
 * Surface table. Roughness/metalness come from the ORM maps; the multipliers
 * here only trim them. Constant roughness is an automatic fail (ART_BIBLE §12),
 * so every entry keeps its map — and every entry now also carries the
 * world-space macro breakup (see mat/macro.js), because a single tiling scale
 * is just as much of a tell as a single roughness value.
 */
export const SURFACES = {
  stone:  () => pbr('stone',  { repeat: 3, detail: 18, detailStrength: 0.5,
            macro: SURFACE_PARAMS.stone }),
  rock:   () => pbr('rock',   { repeat: 2, detail: 16, detailStrength: 0.55,
            macro: SURFACE_PARAMS.rock }),
  ground: () => pbr('rock',   { repeat: 8, detail: 22, detailStrength: 0.5,
            macro: SURFACE_PARAMS.ground }),
  dirt:   () => pbr('dirt',   { repeat: 6, detail: 20, detailStrength: 0.45,
            macro: SURFACE_PARAMS.dirt }),
  snow:   () => pbr('snow',   { repeat: 5, detail: 26, detailStrength: 0.3,
            macro: SURFACE_PARAMS.snow, extra: { color: 0xe8eef8 } }),
  timber: () => pbr('timber', { repeat: 2, detail: 12, detailStrength: 0.4,
            macro: SURFACE_PARAMS.wood }),
  plank:  () => pbr('plank',  { repeat: 2, detail: 12, detailStrength: 0.4,
            macro: SURFACE_PARAMS.wood }),
  bark:   () => pbr('bark',   { repeat: 3, detail: 14, detailStrength: 0.6,
            macro: SURFACE_PARAMS.wood }),
  iron:   () => pbr('iron',   { repeat: 2, detail: 10, detailStrength: 0.35,
            macro: SURFACE_PARAMS.iron }),
  rope:   () => pbr('rope',   { repeat: 4, detail: 8,  detailStrength: 0.5,
            macro: SURFACE_PARAMS.fibre }),
  cloth:  () => pbr('cloth',  { repeat: 3, detail: 10, detailStrength: 0.3,
            sheen: 0.6, macro: SURFACE_PARAMS.fibre }),
  thatch: () => pbr('thatch', { repeat: 4, detail: 14, detailStrength: 0.55,
            macro: SURFACE_PARAMS.fibre }),
};

export function surface(name) {
  const f = SURFACES[name];
  if (!f) throw new Error('no surface: ' + name);
  if (!cache.has('mat:' + name)) cache.set('mat:' + name, f());
  return cache.get('mat:' + name);
}
