import * as THREE from 'three';
import { readAtlas, detailTex } from './atlas.js';
import { CLASS, classifyVertices, smoothClasses, splitIntoGroups } from './segment.js';
import { injectHair, injectSkin, injectBody, injectZombie } from './shading.js';

const ASSETS = '/assets/chars';

/* ------------------------------------------------------------------ tuning */

export const HERO_TUNING = {
  hair: {
    color: 0xc6bdb2,          // pulls the atlas' near-white down to ~0.62 grey
    root: 0x5c4c3e,           // warm dark for roots / interior
    roughness: 0.34,
    anisotropy: 0.9,
    sheen: 0.55,
    sheenColor: 0xe3d3bc,
    sheenRoughness: 0.35,
    envMapIntensity: 1.0,
    strands: 192,             // strands around the body axis
    twist: 5.0,
    normalStrength: 0.60,
    contrast: 1.0,
    ao: 0.62,
    breakup: 0.20,
    detailAcross: 1 / 64,     // strand map holds 64 strands across U -> 3 wraps
    detailAlong: 3.0,
    pivot: [0, 1.45, 0],
  },
  skin: {
    color: 0xffffff,
    roughness: 0.50,
    sssColor: 0xc4544a,       // ART_BIBLE §7
    sssStrength: 0.95,
    sssWrap: 0.45,
    poreRepeat: 64,
    poreScale: 0.55,
    sheen: 0.22,
    sheenColor: 0xffb49a,
    specularIntensity: 0.62,
    envMapIntensity: 0.9,
  },
  body: {
    color: 0xffffff,
    grainRepeat: 44,
    grainScale: 0.85,
    roughLow: 0.42,
    roughHigh: 0.90,
    wear: 0.55,
    metalBias: 0.0,
    sheen: 0.18,
    envMapIntensity: 0.95,
  },
  eyes: {
    seeds: [[-0.062, 1.687], [0.062, 1.687]],
    boxX: 0.038, boxY: 0.026,
    size: 0.0075,
    offset: [0.0, 0.0022, 0.0045],   // up-and-out from the corneal surface
    color: [3.4, 3.5, 3.9],          // >1 so the bloom pass catches it
  },
};

/* Hair is near-white and desaturated; skin sits in a narrow warm hue band.
 * Everything else (leather, cloth, metal, boots) falls through to BODY. */
const HERO_RULES = [
  { cls: CLASS.HAIR, test: (c) => c.lum > 0.62 && c.sat < 0.16 },
  { cls: CLASS.SKIN, test: (c) => c.sat >= 0.16 && c.sat < 0.55 && c.hue > 8 && c.hue < 45 && c.lum > 0.45 },
];

/* ------------------------------------------------------------------ helpers */

function firstSkinnedMesh(root) {
  let found = null;
  root.traverse((o) => { if (!found && (o.isSkinnedMesh || o.isMesh)) found = o; });
  if (!found) throw new Error('chars: no mesh in gltf scene');
  return found;
}

function findBone(root, name) {
  let found = null;
  root.traverse((o) => { if (!found && o.isBone && o.name === name) found = o; });
  return found;
}

/** Soft round highlight, built at runtime so it costs no HTTP round trip. */
let _dotTex = null;
function catchlightTexture() {
  if (_dotTex) return _dotTex;
  const s = 64;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0.00, 'rgba(255,255,255,1)');
  grad.addColorStop(0.22, 'rgba(255,255,255,0.92)');
  grad.addColorStop(0.55, 'rgba(210,225,255,0.28)');
  grad.addColorStop(1.00, 'rgba(180,205,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, s, s);
  _dotTex = new THREE.CanvasTexture(c);
  _dotTex.colorSpace = THREE.SRGBColorSpace;
  return _dotTex;
}

/**
 * ART_BIBLE §8: "catchlight always present". The generated head has the eyes
 * painted flat into the atlas with no separable cornea, so we place additive
 * camera-facing highlights on the eye surface instead. Snapped to the frontmost
 * vertex near each seed so it lands on the cornea rather than floating.
 */
function addCatchlights(root, mesh, cfg) {
  root.updateMatrixWorld(true);
  const head = findBone(root, 'Head') || mesh;
  const pos = mesh.geometry.attributes.position;

  const scale = new THREE.Vector3();
  head.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), scale);
  const inv = 3 / Math.max(scale.x + scale.y + scale.z, 1e-6);

  const made = [];
  for (const [sx, sy] of cfg.seeds) {
    let best = null, bestZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      if (z <= 0) continue;
      if (Math.abs(x - sx) > cfg.boxX || Math.abs(y - sy) > cfg.boxY) continue;
      if (z > bestZ) { bestZ = z; best = new THREE.Vector3(x, y, z); }
    }
    if (!best) continue;
    best.x += cfg.offset[0] * Math.sign(sx || 1);
    best.y += cfg.offset[1];
    best.z += cfg.offset[2];

    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: catchlightTexture(),
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      depthTest: true,
      transparent: true,
      toneMapped: false,
      sizeAttenuation: true,
    }));
    sprite.material.color.setRGB(...cfg.color);
    sprite.scale.setScalar(cfg.size * inv);
    sprite.position.copy(head.worldToLocal(mesh.localToWorld(best.clone())));
    sprite.renderOrder = 12;
    sprite.name = 'catchlight';
    head.add(sprite);
    made.push(sprite);
  }
  return made;
}

/* ------------------------------------------------------------------ hero */

/**
 * Upgrade the generated hero GLB to the reference material standard.
 *
 * The asset ships one primitive, one material and a UV-fragmented atlas, and it
 * declares emissiveFactor [1,1,1] with the albedo as the emissive map — the
 * whole character was self-illuminated at full albedo, which is why the hair
 * clipped to a white blob. We drop the emissive, read the atlas back on the CPU
 * to recover a hair/skin/body material ID, split the index buffer into draw
 * groups on that ID and give each group a purpose-built material.
 */
export function setupHeroMaterials(root, tuning = HERO_TUNING) {
  const mesh = firstSkinnedMesh(root);
  const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const map = src.map;
  if (map) map.colorSpace = THREE.SRGBColorSpace;
  if (map) map.anisotropy = 8;

  const geom = mesh.geometry;
  const report = { groups: null, hair: 0, skin: 0, body: 0 };

  if (!geom.userData.cowSplit) {
    const atlas = readAtlas(map);
    const cls = classifyVertices(geom, atlas, HERO_RULES);
    smoothClasses(cls, geom.index, 2);
    const counts = splitIntoGroups(geom, cls);
    geom.userData.cowSplit = true;
    report.body = counts[CLASS.BODY];
    report.hair = counts[CLASS.HAIR];
    report.skin = counts[CLASS.SKIN];
  }
  report.groups = geom.groups.length;

  const t = tuning;
  const common = { map, metalness: 0.0, side: THREE.DoubleSide, transparent: false };

  /* ---- body: leather, cloth, boots, metal fittings ---- */
  const bodyU = {
    uMetalBias: { value: t.body.metalBias },
    uWear: { value: t.body.wear },
    uRoughLow: { value: t.body.roughLow },
    uRoughHigh: { value: t.body.roughHigh },
  };
  const body = new THREE.MeshPhysicalMaterial({
    ...common,
    name: 'hero_body',
    color: t.body.color,
    roughness: 0.75,
    normalMap: detailTex(`${ASSETS}/leather_grain_normal.png`, t.body.grainRepeat),
    normalScale: new THREE.Vector2(t.body.grainScale, t.body.grainScale),
    sheen: t.body.sheen,
    sheenRoughness: 0.8,
    sheenColor: new THREE.Color(0x9fa8b4),
    envMapIntensity: t.body.envMapIntensity,
  });
  injectBody(body, bodyU);
  body.userData.uniforms = bodyU;

  /* ---- hair: anisotropic, strand-structured, never pure white ---- */
  const hairU = {
    uHairPivot: { value: new THREE.Vector3().fromArray(t.hair.pivot) },
    uStrandDensity: { value: t.hair.strands / (Math.PI * 2) },
    uStrandTwist: { value: t.hair.twist },
    uStrandNormal: { value: t.hair.normalStrength },
    uStrandContrast: { value: t.hair.contrast },
    uHairAO: { value: t.hair.ao },
    uHairBreak: { value: t.hair.breakup },
    uHairDetailScale: { value: new THREE.Vector2(t.hair.detailAcross, t.hair.detailAlong) },
    uHairRoot: { value: new THREE.Color(t.hair.root) },
    uHairDetail: { value: detailTex(`${ASSETS}/hair_strand_normal.png`, 1) },
  };
  const hair = new THREE.MeshPhysicalMaterial({
    ...common,
    name: 'hero_hair',
    color: t.hair.color,
    roughness: t.hair.roughness,
    anisotropy: t.hair.anisotropy,
    anisotropyRotation: 0,
    sheen: t.hair.sheen,
    sheenColor: new THREE.Color(t.hair.sheenColor),
    sheenRoughness: t.hair.sheenRoughness,
    envMapIntensity: t.hair.envMapIntensity,
  });
  injectHair(hair, hairU);
  hair.userData.uniforms = hairU;

  /* ---- skin: wrapped-diffuse subsurface + pore normal ---- */
  const skinU = {
    uSssColor: { value: new THREE.Color(t.skin.sssColor) },
    uSssStrength: { value: t.skin.sssStrength },
    uSssWrap: { value: t.skin.sssWrap },
  };
  const skin = new THREE.MeshPhysicalMaterial({
    ...common,
    name: 'hero_skin',
    color: t.skin.color,
    roughness: t.skin.roughness,
    normalMap: detailTex(`${ASSETS}/skin_pores_normal.png`, t.skin.poreRepeat),
    normalScale: new THREE.Vector2(t.skin.poreScale, t.skin.poreScale),
    sheen: t.skin.sheen,
    sheenColor: new THREE.Color(t.skin.sheenColor),
    sheenRoughness: 0.85,
    specularIntensity: t.skin.specularIntensity,
    envMapIntensity: t.skin.envMapIntensity,
  });
  injectSkin(skin, skinU);
  skin.userData.uniforms = skinU;

  const mats = [];
  mats[CLASS.BODY] = body;
  mats[CLASS.HAIR] = hair;
  mats[CLASS.SKIN] = skin;

  if (src && src !== body) src.dispose?.();
  mesh.material = mats;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;   // skinned bounds are the rest pose; culling pops

  root.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; }
  });

  const sprites = addCatchlights(root, mesh, t.eyes);
  report.catchlights = sprites.length;

  root.userData.cowMaterials = { body, hair, skin };
  root.userData.cowReport = report;
  console.log('[chars] hero materials', JSON.stringify(report));
  return { body, hair, skin, report };
}

/* ------------------------------------------------------------------ zombie */

export const ZOMBIE_TUNING = {
  roughLow: 0.30,     // wet, greasy exposed flesh
  roughHigh: 0.92,    // dry bone, rag, desiccated hide
  wear: 0.45,
  grainRepeat: 52,
  grainScale: 0.95,
  sssColor: 0x6f7a48,
  sssStrength: 0.45,
  sssWrap: 0.30,
  envMapIntensity: 0.85,
  eyeGlow: 0x63d2ff,
  eyeSeeds: [[-0.055, 1.62], [0.055, 1.62]],
};

/**
 * The draugr atlas is close to monochrome — grey-green hide over bone — so
 * there is nothing to gain from splitting draw groups. It gets one material
 * whose roughness is driven per-pixel off the albedo instead: dark rotted flesh
 * reads wet, pale bone and rag read dry (ART_BIBLE §9).
 */
export function setupZombieMaterials(root, tuning = ZOMBIE_TUNING) {
  const mesh = firstSkinnedMesh(root);
  const src = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const map = src.map;
  if (map) { map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8; }

  const u = {
    uMetalBias: { value: 0.0 },
    uWear: { value: tuning.wear },
    uRoughLow: { value: tuning.roughLow },
    uRoughHigh: { value: tuning.roughHigh },
    uSssColor: { value: new THREE.Color(tuning.sssColor) },
    uSssStrength: { value: tuning.sssStrength },
    uSssWrap: { value: tuning.sssWrap },
  };
  const mat = new THREE.MeshPhysicalMaterial({
    name: 'zombie_flesh',
    map,
    color: 0xa9ab96,
    roughness: 0.72,
    metalness: 0.0,
    side: THREE.DoubleSide,
    normalMap: detailTex(`${ASSETS}/leather_grain_normal.png`, tuning.grainRepeat),
    normalScale: new THREE.Vector2(tuning.grainScale, tuning.grainScale),
    sheen: 0.25,
    sheenRoughness: 0.9,
    sheenColor: new THREE.Color(0x8fa07a),
    envMapIntensity: tuning.envMapIntensity,
  });
  injectZombie(mat, u);
  mat.userData.uniforms = u;

  if (src && src !== mat) src.dispose?.();
  mesh.material = mat;
  mesh.frustumCulled = false;
  root.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; }
  });

  // Glowing eyes: reads against fog and gives the bloom pass something to bite
  // on at combat distance (ART_BIBLE §9).
  const glow = addCatchlights(root, mesh, {
    seeds: tuning.eyeSeeds, boxX: 0.04, boxY: 0.03, size: 0.014,
    offset: [0, 0, 0.004],
    color: [tuning.eyeGlow >> 16 & 255, tuning.eyeGlow >> 8 & 255, tuning.eyeGlow & 255]
      .map((v) => (v / 255) * 2.6),
  });

  console.log('[chars] zombie materials, glow sprites', glow.length);
  return { mat };
}
