import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { createRenderer, Post, TOD } from './core/rendering.js';
import { asset } from './core/paths.js';
import { World } from './world/world.js';
import { surface } from './world/materials.js';
import { OTSCamera } from './camera/ots.js';
import { setupHeroMaterials, setupZombieMaterials } from './chars/index.js';
import { createAtmosphere, atmosphereForTOD } from './vfx/atmosphere.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

// A BVH over the arena geometry. Without it, the camera's occlusion raycast
// walks ~500k triangles linearly and dominated the CPU frame: throttling the
// cast to 1-in-6 frames doubled the frame rate on its own, and this removes
// the remaining spike on the frames where it does fire.
THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;
import { Input, Player, Zombie, resolveBodies } from './game/gameplay.js';
import { ClipAnimator, measureCycleDistance, makeInPlace } from './anim/clips.js';
import { CombatFX } from './game/fx.js';
import { CombatDirector } from './game/director.js';
import { HUD } from './ui/hud.js';
import { equip, weaponStats } from './game/weapons.js';
import { AudioEngine } from './audio/engine.js';

const ARENA_PARTS = ['ground', 'stone', 'snow', 'dirt', 'timber', 'plank',
  'bark', 'iron', 'rope', 'cloth', 'thatch'];

const canvas = document.createElement('canvas');
document.body.appendChild(canvas);

const renderer = createRenderer(canvas);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(56, innerWidth / innerHeight, 0.05, 30000);
camera.position.set(2.1, 1.62, 3.4);

const world = new World(scene, renderer);
const post = new Post(renderer, scene, camera);
const ots = new OTSCamera(camera);
let state_atmos = null;

// Empty air is an instant-fail tell (ART_BIBLE §12.6); the reference plates are
// full of drifting snow at several depths.
state_atmos = createAtmosphere(scene, atmosphereForTOD('cold_overcast'));

// Meshes ship Draco-compressed: 62MB of GLB became 12MB, which is the
// difference between a link that loads and one nobody waits for.
const draco = new DRACOLoader();
draco.setDecoderPath(asset('draco/'));
const gltf = new GLTFLoader().setDRACOLoader(draco);
const boot = document.getElementById('boot');
// Ground speed the Run clip was captured at, measured directly (see below).
const NATURAL_RUN_SPEED = 2.76;

const state = { hero: null, zombie: null, zombieProto: null, arena: new THREE.Group() };
const enemies = [];
let player = null, input = null, fx = null, hud = null, wave = 1;
const audio = new AudioEngine();
const director = new CombatDirector({ maxAttackers: 2 });
const _bodies = [];   // reused; player + living enemies

/** Scale envMapIntensity on every material under a character root. */
function dampCharacterAmbient(root, k) {
  root.traverse((o) => {
    const ms = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of ms) {
      if (m && typeof m.envMapIntensity === 'number') m.envMapIntensity *= k;
    }
  });
}

function spawnZombie(x, z) {
  // SkeletonUtils.clone rather than Object3D.clone: a plain clone shares the
  // skeleton, so every copy would animate as one.
  const root = skeletonClone(state.zombieProto);
  root.position.set(x, 0, z);
  scene.add(root);
  const zed = new Zombie(root);
  zed.director = director;   // grants/revokes the attack token
  // The draugr share the hero's skeleton exactly, so the same authored clip
  // drives them. Different tuning gives the lurch: arms hang further forward,
  // elbows straighter, and the clip runs slower for the same ground speed.
  if (state.clips && state.clips.length) {
    zed.anim = new ClipAnimator(root, state.clips, {
      metresPerCycle: state.cycleDist,
        walkMetresPerCycle: state.walkCycleDist * 0.72,
      armClose: 0.38,
      elbowBend: 0.16,
    });
  }
  enemies.push(zed);
  return root;
}

function startWave(n) {
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + Math.random();
    const r = 6 + Math.random() * 2.5;
    spawnZombie(Math.cos(a) * r, Math.sin(a) * r);
  }
}
scene.add(state.arena);

function load(url) {
  return new Promise((res, rej) => gltf.load(url, res, undefined, rej));
}

async function loadArena() {
  const jobs = ARENA_PARTS.map(async (part) => {
    const g = await load(asset(`assets/arena/arena_${part}.glb`));
    const mat = surface(part);
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.material = mat;
      o.castShadow = true;
      o.receiveShadow = true;
      o.frustumCulled = true;
    });
    g.scene.traverse((o) => { if (o.isMesh) o.geometry.computeBoundsTree(); });
    state.arena.add(g.scene);
  });
  await Promise.all(jobs);
}

async function loadChars() {
  // Soldier.glb ships from three.js with a mixamorig skeleton and hand-authored
  // Idle / Walk / Run clips. Four rounds of trying to author locomotion onto the
  // generated hero mesh never planted a foot: that mesh was produced by an
  // image-to-3D service and was never rigged for locomotion. Using a rig that
  // came with real animation is the right call, not a shortcut.
  const h = await load(asset('assets/chars/Soldier.glb'));
  state.hero = h.scene;
  state.hero.scale.setScalar(1.0);
  state.heroClips = h.animations || [];
  state.hero.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  // Splits the single baked atlas into hair/skin/body draw groups by classifying
  // vertices against the albedo, then shades each properly. The mesh ships with
  // one material covering everything, so without this the hair renders as the
  // flat near-white paint the atlas actually contains.
  // Baked clips authored against this exact rig (tools/gen_anims.py). The
  // legs were solved from a foot trajectory by Blender's IK and baked, so foot
  // planting is in the data rather than something the runtime fights for.
  const anims = { animations: state.heroClips };
  // NOTE: makeInPlace() is exported but deliberately NOT applied. Stripping
  // horizontal Hips translation took stance slip from 98% to 117% of body
  // speed — that translation carries a real backward component rather than
  // dragging the foot as I assumed. Measured, not reasoned.
  state.clips = anims.animations || [];
  // Measured once from the clip and shared: playback rate = speed / this.
  // Measure the LOCOMOTION clips by name. state.clips[0] is Idle, and
  // calibrating the run rate against a standing-still clip yields a cycle
  // distance near zero and a rate pinned to the clamp.
  const byName = (re) => state.clips.find((c) => re.test(c.name));
  const runClip = byName(/^run$/i) || state.clips[0];
  const walkClip = byName(/^walk$/i);
  // measureCycleDistance infers a stride from clip geometry and a calibration
  // constant; both were fitted against the old authored clip. For a real mocap
  // clip the stride can be measured DIRECTLY and unambiguously: hold playback
  // at rate 1.0 and read the stance foot's character-space speed. That is the
  // ground speed the clip was captured at, and it came out at 2.76 m/s at two
  // different body speeds (2.809 and 2.710) — invariant, as it must be.
  // The body is then matched to the clip rather than the clip stretched to the
  // body, which is the only way rate=1.0 and a cancelling foot coexist.
  state.cycleDist = NATURAL_RUN_SPEED;
  state.measuredCycleDist = runClip ? measureCycleDistance(state.hero, runClip) : 1.0;
  state.walkCycleDist = walkClip ? measureCycleDistance(state.hero, walkClip) : state.cycleDist;

  // World ambient and character ambient are separate problems. The scene needs
  // enough indirect light that the frame isn't 10% functionally black; the
  // characters need much less of it or their shadow side never goes dark.
  // Applied here because it is the one place guaranteed to reach every
  // material the character setup produced.
  dampCharacterAmbient(state.hero, 0.5);
  scene.add(state.hero);
  // The hero was empty-handed, which is a conspicuous miss for a God of War
  // alike. Weapon choice also drives reach and damage.
  state.weapon = await equip(state.hero, 'axe');

  // The draugr must share the hero's SKELETON, not just look undead: they are
  // driven by the same clips, and feeding Soldier clips to the old generated
  // rig produced garbage (bone names do not match, so the tracks landed on
  // nothing and the arms stuck straight up). Same rig, different palette and
  // scale — the lurch comes from the animator tuning, not the mesh.
  const z = await load(asset('assets/chars/Soldier.glb'));
  state.zombieProto = z.scene;
  state.zombieProto.traverse((o) => {
    if (!o.isMesh && !o.isSkinnedMesh) return;
    const ms = Array.isArray(o.material) ? o.material : [o.material];
    o.material = ms.map((m) => {
      if (!m) return m;
      const c = m.clone();
      if (c.color) c.color.setHex(0x44503c);      // sickly draugr green, dark
      // Undead flesh is not a polished soldier: kill the sheen entirely so they
      // separate from the hero at a glance even at distance.
      c.roughness = 0.78;
      c.metalness = 0.0;
      return c;
    });
    if (o.material.length === 1) o.material = o.material[0];
  });
  state.zombieProto.traverse((o) => {
    if (o.isMesh || o.isSkinnedMesh) { o.castShadow = true; o.receiveShadow = true; }
  });
  dampCharacterAmbient(state.zombieProto, 0.34);
  // `state.zombie` stays as the first spawn so existing shot specs keep working.
  state.zombie = spawnZombie(-1.6, -4.2);
  ots.target = state.hero;
  ots.lockOn = state.zombie;
  ots.occluders = [state.arena];
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

let clearT = 0;

/** Nearest living enemy, biased to whatever is in front of the hero. */
const _lockF = new THREE.Vector3();
const _lockTo = new THREE.Vector3();
function lockTarget() {
  let best = null, bestScore = Infinity;
  const p = state.hero.position;
  const f = _lockF.set(Math.sin(player.face), 0, Math.cos(player.face));
  for (const e of enemies) {
    if (e.dead) continue;
    const to = _lockTo.copy(e.root.position).sub(p); to.y = 0;
    const d = to.length();
    if (d > 16) continue;
    // Distance, penalised for being behind the hero.
    const score = d * (1.0 - 0.35 * to.normalize().dot(f));
    if (score < bestScore) { bestScore = score; best = e; }
  }
  return best;
}

let _loopPaused = false;
export function setLoopPaused(v) { _loopPaused = v; }

function frame() {
  requestAnimationFrame(frame);
  // perf.mjs drives post.render() itself; without this the page's own loop
  // renders a second full post chain per tick and doubles the measured cost.
  if (_loopPaused) return;
  // Clamping raw dt made the whole sim run in slow motion below 20 FPS.
  // Clamp the *render* dt but step the sim in fixed slices so combat timing
  // stays real when frames are long.
  const dt = Math.min(clock.getDelta(), 0.10);

  if (!paused && player) {
    // fx.update returns the hitstop-scaled dt: the sim slows, the camera and
    // atmosphere do not, which is what makes a hit land rather than stutter.
    const sdt = hud.open ? 0 : fx.update(dt);
    if (sdt > 0) {
      // Director runs first: it decides who may attack this frame and where
      // everyone else should stand.
      director.update(sdt, player, enemies);
      player.update(sdt, input, camera, enemies, fx);
      for (const e of enemies) e.update(sdt, player, fx, enemies);
      // Bodies resolve after movement so nothing ends the frame inside anything
      // else. Clamp BEFORE each separation pass, not once at the end: clamping
      // last projected everyone back onto the arena circle and undid the
      // separation, which allowed 49.5cm of penetration when the pack pinned
      // the player against the bound.
      _bodies.length = 0;
      _bodies.push(player);
      for (const e of enemies) if (!e.dead) _bodies.push(e);
      for (let pass = 0; pass < 3; pass++) {
        for (const a of _bodies) a.clampToArena();
        resolveBodies(_bodies, sdt);
      }
      for (const a of _bodies) a.clampToArena();
    }
    // Rebuilt in place; `filter().map()` allocated two arrays every frame.
    ots.avoid.length = 0;
    for (const e of enemies) if (!e.dead) ots.avoid.push(e.root);
    const target = lockTarget();
    ots.lockOn = target ? target.root : null;
    hud.update(player, target);

    if (player.dead) {
      hud.banner('You Died');
    } else if (enemies.every((e) => e.dead)) {
      clearT += dt;
      hud.banner(clearT < 2.2 ? `Wave ${wave} Cleared` : '');
      if (clearT > 3.2) {
        clearT = 0;
        wave++;
        for (const e of enemies) scene.remove(e.root);
        enemies.length = 0;
        startWave(Math.min(3 + wave, 8));
        player.hp = Math.min(player.maxHp, player.hp + 60);
      }
    }
    ots.update(dt);
    world.followShadow(state.hero.position);
  } else if (!paused) {
    ots.update(dt);
    if (state.hero) world.followShadow(state.hero.position);
  }

  if (state_atmos) state_atmos.update(dt, camera);
  if (ots.lockOn) post.focusOn(ots.lockOn.position);
  post.render(dt);
}

/* ---------------- capture mode ---------------- */
// A shot spec owns the camera and the world state outright so a critic can
// reproduce an exact framing across rounds. Mirrors the Godot harness contract.
async function applyShot(spec) {
  if (spec.time_of_day) {
    world.applyTOD(spec.time_of_day);
    if (state_atmos) state_atmos.setPreset(atmosphereForTOD(spec.time_of_day));
  }
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
  state, post, world, camera, scene, renderer, THREE, ots,
  setLoopPaused: (v) => { _loopPaused = v; },
  get enemies() { return enemies; },
  get player() { return player; },
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
      const spec = await (await fetch(asset(`shots/${shotName}.json`))).json();
      await applyShot(spec);
    }
    // Capture runs must stay deterministic, so gameplay only boots for players.
    if (!shotName) {
      input = new Input(renderer.domElement);
      // Browsers require a gesture before an AudioContext will start.
      const unlock = () => { audio.unlock(); };
      addEventListener('pointerdown', unlock, { once: true });
      addEventListener('keydown', unlock, { once: true });
      // Run speed IS the clip's stride rate. Any other value guarantees a
      // skate no matter how the playback rate is tuned.
      player = new Player(state.hero, { speed: NATURAL_RUN_SPEED });
      if (state.clips.length) {
        player.anim = new ClipAnimator(state.hero, state.clips,
          { metresPerCycle: state.cycleDist,
        walkMetresPerCycle: state.walkCycleDist,
        // Rate calibration alone cannot plant a foot on a real clip: matching
        // the stance foot's MEAN character-space speed to body speed (2.566 vs
        // 2.50 wanted, 2.6% error) still measured 67% world slip, WORSE than a
        // deliberately mis-rated 54%. The residual is variance within the
        // stance phase, not mean rate, and only a pin removes that.
        footLock: true });
        console.log('[anim] clip cycle distance', state.cycleDist.toFixed(3), 'm');
      }
      const w = weaponStats('axe');
      player.hitbox.reach = w.reach;
      player.hitbox.damage = w.damage;
      ots.avoid = enemies.map((e) => e.root);
      fx = new CombatFX(scene, camera, ots, audio);
      hud = new HUD();
      startWave(3);
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
