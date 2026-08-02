import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { asset } from '../core/paths.js';
import { canonBone } from '../anim/procedural.js';

/**
 * Weapon meshes parented to a character's hand bone.
 *
 * The meshes are authored grip-at-origin with +Y along the shaft
 * (tools/gen_weapons.py), but a hand bone's local axes are whatever the rig
 * exporter chose, so each weapon still needs a grip transform to sit in the
 * fist correctly. Those are tuned per weapon below rather than guessed.
 */

/**
 * `aim` is the direction the weapon's +Y shaft should point, in the CHARACTER's
 * local space. Solving for the grip quaternion from that is far more reliable
 * than hand-tuning Euler angles against an unknown bone orientation.
 * -Z is the character's forward, +Y up, +X their left.
 */
const WEAPONS = {
  axe:    { file: 'axe',    aim: [0.16, 0.80, 0.58],   roll: 0.15, grip: [0, 0.02, 0], scale: 1.0,
            reach: 2.4, damage: 34, name: 'Leviathan' },
  blade:  { file: 'blade',  aim: [0.08, 0.62, 0.78],   roll: 0.0,  grip: [0, 0.02, 0], scale: 1.0,
            reach: 2.1, damage: 24, name: 'Twin Blade' },
  spear:  { file: 'spear',  aim: [0.05, 0.25, -0.97],  roll: 0.0,  grip: [0, -0.32, 0], scale: 1.0,
            reach: 3.1, damage: 28, name: 'War Spear' },
  hammer: { file: 'hammer', aim: [0.16, 0.82, 0.55],  roll: 0.15, grip: [0, 0.02, 0], scale: 1.0,
            reach: 2.5, damage: 48, name: 'Great Hammer' },
};

let _loader = null;
function loader() {
  if (!_loader) {
    const d = new DRACOLoader();
    d.setDecoderPath(asset('draco/'));
    _loader = new GLTFLoader().setDRACOLoader(d);
  }
  return _loader;
}

const cache = new Map();

async function loadWeapon(key) {
  if (cache.has(key)) return cache.get(key).clone(true);
  const spec = WEAPONS[key];
  const g = await new Promise((res, rej) =>
    loader().load(asset(`assets/weapons/${spec.file}.glb`), res, undefined, rej));
  const root = g.scene;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true;
    o.receiveShadow = true;
    const m = o.material;
    if (m) {
      // Blender's glTF export writes metal as metalness 1 with no map. Keep it
      // strictly 0 or 1 (ART_BIBLE §7) but give the roughness some variation so
      // the blade does not read as a chrome cutout.
      m.envMapIntensity = 1.35;
      if (m.metalness > 0.5) { m.metalness = 1.0; m.roughness = Math.max(0.18, m.roughness); }
      else m.metalness = 0.0;
    }
  });
  cache.set(key, root);
  return root.clone(true);
}

/**
 * Attach a weapon to `RightHand`. Returns the weapon root, or null if the rig
 * has no such bone (in which case the caller should simply carry on unarmed).
 */
export async function equip(characterRoot, key = 'axe') {
  const spec = WEAPONS[key];
  if (!spec) throw new Error('unknown weapon: ' + key);

  let hand = null;
  characterRoot.traverse((o) => {
    if (!hand && o.isBone && canonBone(o.name) === 'RightHand') hand = o;
  });
  if (!hand) return null;

  const mesh = await loadWeapon(key);
  const pivot = new THREE.Object3D();
  pivot.name = 'weapon_' + key;

  characterRoot.updateWorldMatrix(true, true);

  // The hand bone carries the rig's own scale, which on these characters is
  // tiny — parenting naively produced a 1cm axe. Cancel the inherited scale so
  // the weapon keeps the real-world size it was authored at.
  const hs = new THREE.Vector3();
  hand.getWorldScale(hs);
  const inv = 1 / Math.max(1e-6, (hs.x + hs.y + hs.z) / 3);
  pivot.scale.setScalar(spec.scale * inv);
  pivot.position.fromArray(spec.grip.map((v) => v * inv));

  // Solve the grip: the rotation taking the weapon's +Y shaft to the desired
  // direction, expressed in the hand bone's frame.
  const handQ = new THREE.Quaternion();
  hand.getWorldQuaternion(handQ);
  const charQ = new THREE.Quaternion();
  characterRoot.getWorldQuaternion(charQ);
  const aimWorld = new THREE.Vector3().fromArray(spec.aim).normalize()
    .applyQuaternion(charQ);
  const want = new THREE.Quaternion()
    .setFromUnitVectors(new THREE.Vector3(0, 1, 0), aimWorld);
  pivot.quaternion.copy(handQ).invert().multiply(want);
  if (spec.roll) {
    pivot.quaternion.multiply(
      new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spec.roll));
  }

  pivot.add(mesh);
  hand.add(pivot);

  characterRoot.userData.weapon = { key, ...spec, pivot };
  return pivot;
}

export function weaponStats(key) {
  return WEAPONS[key] || WEAPONS.axe;
}

export const ROSTER = Object.keys(WEAPONS);
