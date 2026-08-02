#!/usr/bin/env node
/**
 * Motion capture harness — records a frame strip while driving scripted input.
 *
 * Stills cannot show physics. Foot sliding, weight, recovery, knockback decay
 * and ragdoll settle are all *motion* defects and every one of them is
 * invisible in a screenshot. This drives the real game with a scripted input
 * sequence and dumps evenly-spaced frames plus a per-frame telemetry log, so
 * motion can be judged and measured rather than guessed at.
 *
 *   node motion.mjs --name walk   --script walk   --frames 24
 *   node motion.mjs --name combat --script combat --frames 24 --q high
 */
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BASE = process.env.COW_URL || 'http://localhost:5173';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const NAME = arg('name', 'motion');
const SCRIPT = arg('script', 'walk');
const FRAMES = Number(arg('frames', 24));
const Q = arg('q', 'high');
const W = Number(arg('w', 960)), H = Number(arg('h', 540));

const OUT = path.join(ROOT, 'shots', 'motion', NAME);
fs.mkdirSync(OUT, { recursive: true });

const SCRIPTS = {
  // Straight-line run: exposes foot sliding and gait/speed mismatch.
  walk: async (page) => { await page.keyboard.down('KeyW'); },
  // Strafe: exposes turn snapping and whether the body leads the feet.
  strafe: async (page) => { await page.keyboard.down('KeyD'); },
  // Approach, then a full 3-hit combo: exposes lunge, commitment, recovery.
  combat: async (page) => {
    await page.keyboard.down('KeyW');
    await new Promise(r => setTimeout(r, 900));
    await page.keyboard.up('KeyW');
    for (let i = 0; i < 3; i++) {
      await page.mouse.click(W / 2, H / 2);
      await new Promise(r => setTimeout(r, 260));
    }
  },
  // Dodge roll: exposes i-frame window readability and momentum.
  dodge: async (page) => {
    await page.keyboard.down('KeyW');
    await new Promise(r => setTimeout(r, 500));
    await page.keyboard.press('Space');
  },
  // Kill something and watch it fall: exposes death physics.
  death: async (page) => {
    await page.keyboard.down('KeyW');
    await new Promise(r => setTimeout(r, 1100));
    await page.keyboard.up('KeyW');
    for (let i = 0; i < 8; i++) {
      await page.mouse.click(W / 2, H / 2);
      await new Promise(r => setTimeout(r, 230));
    }
  },
};

const browser = await puppeteer.launch({
  headless: false,
  args: ['--use-angle=metal', '--enable-gpu', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto(`${BASE}/?q=${Q}`, { waitUntil: 'domcontentloaded', timeout: 150000 });
await page.waitForFunction('window.__COW_READY === true || window.__COW_ERROR', { timeout: 180000 });
const err = await page.evaluate('window.__COW_ERROR || null');
if (err) { console.error('page error:', String(err).slice(0, 300)); await browser.close(); process.exit(2); }
await new Promise(r => setTimeout(r, 1200));

// Telemetry the critic can measure instead of eyeballing: foot world positions
// while grounded are the direct test for sliding.
await page.evaluate(() => {
  window.__TELEM = [];
  const { player } = window.__COW;
  const rig = player.anim && player.anim.rig;
  window.__sampleTelem = () => {
    const p = window.__COW.player;
    const e = window.__COW.enemies.filter(x => !x.dead);
    const row = {
      t: performance.now(),
      pos: p.root.position.toArray().map(v => +v.toFixed(4)),
      vel: p.vel.length().toFixed(3),
      state: p.state,
      enemies: e.length,
    };
    if (rig && rig.b.LeftFoot) {
      const v = new window.__COW.THREE.Vector3();
      rig.b.LeftFoot.getWorldPosition(v);
      row.lfoot = v.toArray().map(n => +n.toFixed(4));
      rig.b.RightFoot.getWorldPosition(v);
      row.rfoot = v.toArray().map(n => +n.toFixed(4));
    }
    window.__TELEM.push(row);
  };
});

(SCRIPTS[SCRIPT] || SCRIPTS.walk)(page);

for (let i = 0; i < FRAMES; i++) {
  await page.evaluate(() => window.__sampleTelem());
  await page.screenshot({ path: path.join(OUT, String(i).padStart(3, '0') + '.png') });
  await new Promise(r => setTimeout(r, 60));
}

const telem = await page.evaluate('JSON.stringify(window.__TELEM)');
fs.writeFileSync(path.join(OUT, 'telemetry.json'), telem);
await browser.close();
console.log(`${FRAMES} frames -> ${OUT}`);
console.log(`telemetry -> ${path.join(OUT, 'telemetry.json')}`);
