import * as THREE from 'three';
import { sampleAtlas, hsvOf } from './atlas.js';

export const CLASS = { BODY: 0, HAIR: 1, SKIN: 2 };
export const CLASS_COUNT = 3;

/**
 * Per-vertex material classification from the albedo atlas.
 *
 * `rules` is an ordered list of predicates; the first match wins, otherwise the
 * vertex falls through to BODY. Each character supplies its own rule set
 * because the palettes differ (the hero's hair is near-white, the draugr's
 * exposed bone occupies the same corner of the colour space).
 */
export function classifyVertices(geometry, atlas, rules) {
  const uv = geometry.attributes.uv;
  const n = uv.count;
  const cls = new Uint8Array(n);
  const rgb = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    sampleAtlas(atlas, uv.getX(i), uv.getY(i), rgb);
    const c = hsvOf(rgb[0], rgb[1], rgb[2]);
    let k = CLASS.BODY;
    for (let r = 0; r < rules.length; r++) {
      if (rules[r].test(c, rgb)) { k = rules[r].cls; break; }
    }
    cls[i] = k;
  }
  return cls;
}

/**
 * Majority-vote smoothing over the mesh's edge graph.
 *
 * Straight per-texel classification speckles badly where charts are noisy — a
 * lone SKIN vertex inside the hair mass would otherwise pull a whole triangle
 * into the skin draw group and show up as a bright wax dot. Two passes is
 * enough to remove isolated vertices without eroding real boundaries.
 */
export function smoothClasses(cls, index, iters = 2, selfBias = 2) {
  const n = cls.length;
  const idx = index.array;
  for (let it = 0; it < iters; it++) {
    const votes = new Uint16Array(n * CLASS_COUNT);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      votes[a * CLASS_COUNT + cls[b]]++; votes[a * CLASS_COUNT + cls[c]]++;
      votes[b * CLASS_COUNT + cls[a]]++; votes[b * CLASS_COUNT + cls[c]]++;
      votes[c * CLASS_COUNT + cls[a]]++; votes[c * CLASS_COUNT + cls[b]]++;
    }
    const next = new Uint8Array(n);
    for (let v = 0; v < n; v++) {
      const base = v * CLASS_COUNT;
      let best = cls[v], bestN = votes[base + cls[v]] + selfBias;
      for (let k = 0; k < CLASS_COUNT; k++) {
        if (votes[base + k] > bestN) { bestN = votes[base + k]; best = k; }
      }
      next[v] = best;
    }
    cls.set(next);
  }
  return cls;
}

/**
 * Reorder the index buffer so each class occupies one contiguous run, then
 * declare those runs as draw groups. This is what buys us per-region materials
 * on a mesh that shipped with a single material slot — hair can be anisotropic
 * and skin can be subsurface without touching the source asset.
 */
export function splitIntoGroups(geometry, cls) {
  const index = geometry.index;
  const src = index.array;
  const triCount = src.length / 3;

  const triClass = new Uint8Array(triCount);
  const counts = new Int32Array(CLASS_COUNT);
  for (let t = 0; t < triCount; t++) {
    const a = cls[src[t * 3]], b = cls[src[t * 3 + 1]], c = cls[src[t * 3 + 2]];
    // majority of three; ties fall to the first vertex
    const k = (a === b || a === c) ? a : (b === c ? b : a);
    triClass[t] = k;
    counts[k]++;
  }

  const starts = new Int32Array(CLASS_COUNT);
  let acc = 0;
  for (let k = 0; k < CLASS_COUNT; k++) { starts[k] = acc; acc += counts[k]; }
  const cursor = Int32Array.from(starts);

  const dst = new src.constructor(src.length);
  for (let t = 0; t < triCount; t++) {
    const w = cursor[triClass[t]]++ * 3;
    dst[w] = src[t * 3]; dst[w + 1] = src[t * 3 + 1]; dst[w + 2] = src[t * 3 + 2];
  }

  geometry.setIndex(new THREE.BufferAttribute(dst, 1));
  geometry.clearGroups();
  for (let k = 0; k < CLASS_COUNT; k++) {
    if (counts[k] > 0) geometry.addGroup(starts[k] * 3, counts[k] * 3, k);
  }
  return counts;
}
