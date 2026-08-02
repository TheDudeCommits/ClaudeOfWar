import * as THREE from 'three';

/**
 * The fighter roster.
 *
 * There is one generated character mesh, so the fighters are differentiated by
 * everything that actually changes how they play and read: weapon (which drives
 * reach and damage), stat block, palette, and a distinct special ability with
 * its own cost and behaviour. That is real differentiation — a second mesh
 * would change the silhouette but not the game.
 *
 * Palettes are applied as a tint over the shared atlas rather than as new
 * textures, so switching fighters costs nothing at load.
 */

export const FIGHTERS = [
  {
    id: 'ashvald',
    name: 'Ashvald',
    title: 'The Frostbound',
    weapon: 'axe',
    hp: 200, speed: 3.4, staminaRegen: 26,
    tint: { hair: 0xb6aa9c, cloth: 0x2d4a5c, metal: 0xc8ccd2 },
    ability: {
      id: 'frost_throw',
      name: 'Frost Throw',
      cost: 40,
      desc: 'Hurl the axe along a line, freezing everything it passes.',
    },
    blurb: 'Heavy, deliberate, punishing. The baseline against which the others read.',
  },
  {
    id: 'kaen',
    name: 'Kaen',
    title: 'The Twin Flame',
    weapon: 'blade',
    hp: 150, speed: 4.5, staminaRegen: 36,
    tint: { hair: 0x2a1e22, cloth: 0x6e1d1d, metal: 0xe2c07a },
    ability: {
      id: 'flurry',
      name: 'Ember Flurry',
      cost: 35,
      desc: 'Dash through every enemy in a short cone, striking each once.',
    },
    blurb: 'Fast and fragile. Trades reach and damage for mobility and stamina.',
  },
  {
    id: 'sylra',
    name: 'Sylra',
    title: 'The Long Watch',
    weapon: 'spear',
    hp: 170, speed: 3.8, staminaRegen: 30,
    tint: { hair: 0xd8d2c0, cloth: 0x24503f, metal: 0xb9bec6 },
    ability: {
      id: 'impale',
      name: 'Impale',
      cost: 35,
      desc: 'A committed lunge that skewers everything in a long line.',
    },
    blurb: 'Controls space. The longest reach in the roster by a wide margin.',
  },
  {
    id: 'brand',
    name: 'Brand',
    title: 'The Breaker',
    weapon: 'hammer',
    hp: 260, speed: 2.8, staminaRegen: 20,
    tint: { hair: 0x8a6a3c, cloth: 0x3b3128, metal: 0x9aa0a8 },
    ability: {
      id: 'quake',
      name: 'Quake',
      cost: 50,
      desc: 'Slam the ground; a radial shockwave staggers and throws.',
    },
    blurb: 'Slowest and toughest. Every swing commits, and every swing matters.',
  },
];

export function fighterById(id) {
  return FIGHTERS.find((f) => f.id === id) || FIGHTERS[0];
}

/** Apply a fighter's palette to an already-shaded character. */
export function applyTint(root, tint) {
  root.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : (o.material ? [o.material] : []);
    for (const m of mats) {
      if (!m || !m.color) continue;
      const g = m.userData?.cowGroup;   // 'hair' | 'skin' | 'body', set by chars/
      if (g === 'hair' && tint.hair) m.color.setHex(tint.hair);
      else if (g === 'body' && tint.cloth) m.color.setHex(tint.cloth);
    }
  });
  const w = root.userData?.weapon;
  if (w && tint.metal) {
    w.pivot.traverse((o) => {
      if (o.isMesh && o.material && o.material.metalness > 0.5) {
        o.material.color.setHex(tint.metal);
      }
    });
  }
}

/**
 * Special abilities. Each returns true if it fired.
 * `ctx` = { player, enemies, fx, scene, camera, audio }
 */
export const ABILITIES = {
  frost_throw(ctx) {
    const { player, enemies, fx } = ctx;
    const origin = player.root.position.clone().setY(1.2);
    const f = new THREE.Vector3(Math.sin(player.face), 0, Math.cos(player.face));
    let hits = 0;
    for (const e of enemies) {
      if (e.dead) continue;
      const to = e.root.position.clone().sub(origin); to.y = 0;
      const along = to.dot(f);
      if (along < 0 || along > 11) continue;
      if (to.lengthSq() - along * along > 1.0) continue;   // ~1m corridor
      e.hurt(46, to);
      e.stagger = 1.4;                                      // "frozen"
      e.frozen = 1.4;
      hits++;
      fx.impact(e.root.position.clone().setY(1.15), 0.9);
    }
    fx.beam?.(origin, origin.clone().addScaledVector(f, 11));
    return hits >= 0;
  },

  flurry(ctx) {
    const { player, enemies, fx } = ctx;
    const origin = player.root.position.clone();
    const f = new THREE.Vector3(Math.sin(player.face), 0, Math.cos(player.face));
    let n = 0;
    for (const e of enemies) {
      if (e.dead) continue;
      const to = e.root.position.clone().sub(origin); to.y = 0;
      const d = to.length();
      if (d > 5.5) continue;
      if (to.clone().normalize().dot(f) < 0.35) continue;   // forward cone
      e.hurt(30, to);
      e.stagger = 0.5;
      n++;
      fx.impact(e.root.position.clone().setY(1.15), 0.7);
    }
    // Dash to just past the furthest thing struck.
    player.vel.copy(f).multiplyScalar(14);
    player.iframes = Math.max(player.iframes, 0.35);
    return n >= 0;
  },

  impale(ctx) {
    const { player, enemies, fx } = ctx;
    const origin = player.root.position.clone().setY(1.1);
    const f = new THREE.Vector3(Math.sin(player.face), 0, Math.cos(player.face));
    for (const e of enemies) {
      if (e.dead) continue;
      const to = e.root.position.clone().sub(origin); to.y = 0;
      const along = to.dot(f);
      if (along < 0 || along > 6.5) continue;
      if (to.lengthSq() - along * along > 0.8) continue;
      e.hurt(58, to);
      e.stagger = 0.9;
      fx.impact(e.root.position.clone().setY(1.15), 1.0);
    }
    player.vel.copy(f).multiplyScalar(9);
    return true;
  },

  quake(ctx) {
    const { player, enemies, fx } = ctx;
    const origin = player.root.position.clone();
    for (const e of enemies) {
      if (e.dead) continue;
      const to = e.root.position.clone().sub(origin); to.y = 0;
      const d = to.length();
      if (d > 6.0) continue;
      const falloff = 1 - d / 6.0;
      e.hurt(40 * falloff + 18, to);
      e.stagger = 1.1;
      // Thrown outward, hard.
      e.vel.copy(to.normalize()).multiplyScalar(9 * falloff);
      fx.impact(e.root.position.clone().setY(0.9), falloff);
    }
    fx.shockwave?.(origin);
    fx.impact(origin.clone().setY(0.4), 1.3);
    return true;
  },
};

export function useAbility(fighter, ctx) {
  const a = fighter.ability;
  const { player } = ctx;
  if (player.rage < a.cost) return false;
  const fn = ABILITIES[a.id];
  if (!fn) return false;
  if (fn(ctx) === false) return false;
  player.rage -= a.cost;
  return true;
}
