import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createRenderer, Post, TOD } from './core/rendering.js';
import { World } from './world/world.js';
import { surface } from './world/materials.js';
import { OTSCamera } from './camera/ots.js';

const ARENA_PARTS = ['ground', 'stone', 'snow', 'dirt', 'timber', 'plank',
  'bark', 'iron', 'rope', 'cloth', 'thatch'];

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const renderer = createRenderer(canvas);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(56, innerWidth / innerHeight, 0.05, 800);
camera.position.set(2.1, 1.62, 3.4);

const world = new World(scene, renderer);
const post = new Post(renderer, scene, camera);
const ots = new OTSCamera(camera);

const gltf = new GLTFLoader();
const boot = document.getElementById('boot');
const state = { hero: null, zombie: null, arena: new THREE.Group() };
scene.add(state.arena);

function load(url) {
  return new Promise((res, rej) => gltf.load(url, res, undefined, rej));
}

async function loadArena() {
  const jobs = ARENA_PARTS.map(async (part) => {
    const g = await load(`/assets/arena/arena_${part}.glb`);
    const mat = surface(part);
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.material = mat;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = true;
    });
    state.arena.add(g.scene);
  });
  await Promise.all(jobs);
}

async function loadChars() {
  const h = await load('/assets/chars/hero_ashvald.glb');
  state.hero = h.scene;
  state.heroClips = h.animations || [];
  state.hero.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const m = o.material;
    if (m) {
      // Generated meshes arrive with flat, plastic PBR values. Skin needs real
      // subsurface response or it reads as painted vinyl (ART_BIBLE §8).
      m.roughness = 0.52;
      m.metalness = 0.0;
      m.envMapIntensity = 1.0;
      if (m.map) m.map.colorSpace = THREE.SRGBColorSpace;
    }
  });
  scene.add(state.hero);

  const z = await load('/assets/chars/zombie_draugr.glb');
  state.zombie = z.scene;
  state.zombie.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) {
      o.castShadow = true; o.receiveShadow = true;
      if (o.material) { o.material.roughness = 0.62; o.material.metalness = 0.0; }
    }
  });
  state.zombie.position.set(-1.6, 0, -4.2);
  scene.add(state.zombie);

  ots.target = state.hero;
  ots.lockOn = state.zombie;
}

function resize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h, false);
  post.setSize(w, h);
}
addEventListener('resize', resize);

const clock = new THREE.Clock();
let paused = false;

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.05);
  if (!paused) {
    ots.update(dt);
    if (state.hero) world.followShadow(state.hero.position);
  }
  if (ots.lockOn) post.focusOn(ots.lockOn.position);
  post.render(dt);
}

/* ---------------- capture mode ---------------- */
// A shot spec owns the camera and the world state outright so a critic can
// reproduce an exact framing across rounds. Mirrors the Godot harness contract.
async function applyShot(spec) {
  if (spec.time_of_day) { world.applyTOD(spec.time_of_day); }
  if (spec.grade) {
    for (const [k, v] of Object.entries(spec.grade)) post.grade.set(k, v);
  } else if (world.preset.grade) {
    for (const [k, v] of Object.entries(world.preset.grade)) post.grade.set(k, v);
  }
  post.bloom.intensity = world.preset.bloom ?? 1.1;

  if (spec.actors) {
    for (const [name, t] of Object.entries(spec.actors)) {
      const o = state[name];
      if (!o) continue;
      if (t.pos) o.position.fromArray(t.pos);
      if (t.rot_y !== undefined) o.rotation.y = THREE.MathUtils.degToRad(t.rot_y);
      if (t.hidden) o.visible = false;
    }
  }
  const c = spec.camera || {};
  paused = true;

  if (c.rig === 'ots') {
    // Frame with the real gameplay camera rather than hand-placed coordinates,
    // so the critic judges the framing players actually get.
    ots.enabled = true;
    ots.target = state.hero;
    ots.lockOn = state.zombie;
    if (c.fov) ots.fovBase = c.fov;
    if (c.distance) ots.distance = c.distance;
    if (c.shoulder) ots.shoulder.fromArray(c.shoulder);
    if (c.pitch !== undefined) ots.pitch = THREE.MathUtils.degToRad(c.pitch);
    ots._init = false;
    ots.update(1 / 60);   // snaps on first update
    ots.enabled = false;
    post.focusOn(state.zombie.position.clone().setY(1.1));
  } else {
    ots.enabled = false;
    if (c.pos) camera.position.fromArray(c.pos);
    if (c.look_at) camera.lookAt(new THREE.Vector3().fromArray(c.look_at));
    if (c.fov) { camera.fov = c.fov; camera.updateProjectionMatrix(); }
    if (c.focus_at) post.focusOn(new THREE.Vector3().fromArray(c.focus_at));
    else if (c.look_at) post.focusOn(new THREE.Vector3().fromArray(c.look_at));
  }
  if (spec.exposure !== undefined) post.exposure.exposure = spec.exposure;
  if (state.hero) world.followShadow(
    c.look_at ? new THREE.Vector3().fromArray(c.look_at) : state.hero.position);
  world.refreshEnvironment();
}

window.__COW = {
  applyShot,
  // Effects with temporal accumulation (AO denoise, SMAA, adaptive tonemap)
  // need real frames before the image settles; capturing early is unfair.
  async settle(n = 45) {
    for (let i = 0; i < n; i++) {
      await new Promise((r) => requestAnimationFrame(r));
      post.render(1 / 60);
    }
  },
  state, post, world, camera, scene, renderer, THREE,
};

(async function init() {
  try {
    boot.textContent = 'loading arena…';
    await loadArena();
    boot.textContent = 'loading characters…';
    await loadChars();
    resize();
    const params = new URLSearchParams(location.search);
    const shotName = params.get('shot');
    if (shotName) {
      const spec = await (await fetch(`/shots/${shotName}.json`)).json();
      await applyShot(spec);
    }
    boot.classList.add('gone');
    frame();
    window.__COW_READY = true;
  } catch (e) {
    window.__COW_ERROR = (window.__COW_ERROR || '') + '\n' + (e.stack || e);
    boot.textContent = 'FAILED: ' + e.message;
    throw e;
  }
})();
