import * as THREE from 'three';

/**
 * CPU-side reader for a character's baked albedo atlas.
 *
 * The generated characters ship a single UV-fragmented atlas and a single
 * material slot, so there is no authored way to tell hair from skin from
 * leather. The atlas pixels *do* carry that information — hair is painted
 * near-white and desaturated, skin is a narrow warm hue band, leather is a
 * darker warm band — so we read the atlas back on the CPU and use it as the
 * material ID map the asset never came with.
 */
export function readAtlas(texture) {
  const img = texture?.image;
  if (!img) throw new Error('atlas: texture has no image');
  const w = img.width, h = img.height;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // Full resolution, no downsample: the atlas charts butt directly against each
  // other, so any filtering bleeds hair white into skin and vice versa.
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h).data;
  return { data, w, h };
}

/** Sample the atlas at a glTF UV. glTF textures are flipY:false, so v maps
 *  straight to the image row from the top — no flip. */
export function sampleAtlas(atlas, u, v, out) {
  const { data, w, h } = atlas;
  let x = Math.floor(u * w), y = Math.floor(v * h);
  x = x < 0 ? 0 : x >= w ? w - 1 : x;
  y = y < 0 ? 0 : y >= h ? h - 1 : y;
  const i = (y * w + x) * 4;
  out[0] = data[i] / 255; out[1] = data[i + 1] / 255; out[2] = data[i + 2] / 255;
  return out;
}

/** sRGB triplet -> { lum, sat, hue(deg) }. Cheap HSV, no allocation. */
const _hsv = { lum: 0, sat: 0, hue: 0, val: 0 };
export function hsvOf(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  _hsv.val = mx;
  _hsv.lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  _hsv.sat = mx > 1e-5 ? d / mx : 0;
  let hue = 0;
  if (d > 1e-5) {
    if (mx === r) hue = (g - b) / d;
    else if (mx === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  _hsv.hue = hue;
  return _hsv;
}

/** Load a tiling detail map. */
const _cache = new Map();
export function detailTex(url, repeat = 1, srgb = false) {
  const key = url + '|' + repeat + '|' + srgb;
  if (_cache.has(key)) return _cache.get(key);
  const t = new THREE.TextureLoader().load(url);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.setScalar(repeat);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  _cache.set(key, t);
  return t;
}
