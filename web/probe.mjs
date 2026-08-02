#!/usr/bin/env node
/**
 * Physics probe — per-rAF telemetry, far denser than motion.mjs's ~6 Hz.
 *
 * motion.mjs samples once per screenshot (60 ms sleep + a full PNG encode, so
 * really ~150-300 ms apart). Foot slide, velocity ramps and swing arcs all live
 * at 16 ms. This hooks requestAnimationFrame and records every simulated frame,
 * then dumps raw JSON for offline analysis. Read-only: it never writes into the
 * game, it only observes.
 *
 *   node probe.mjs --script run --secs 4 --out run
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

const SCRIPT = arg('script', 'run');
const SECS = Number(arg('secs', 4));
const OUTNAME = arg('out', SCRIPT);
const Q = arg('q', 'medium');
const W = 960, H = 540;
const OUT = path.join(ROOT, 'shots', 'motion', OUTNAME);
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  headless: false,
  args: ['--use-angle=metal', '--enable-gpu', '--no-sandbox',
    '--autoplay-policy=no-user-gesture-required', `--window-size=${W},${H}`],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.error('PAGEERR', String(e).slice(0, 200)));
await page.goto(`${BASE}/?q=${Q}`, { waitUntil: 'domcontentloaded', timeout: 150000 });
await page.waitForFunction('window.__COW_READY === true || window.__COW_ERROR', { timeout: 180000 });
const err = await page.evaluate('window.__COW_ERROR || null');
if (err) { console.error('page error:', String(err).slice(0, 400)); await browser.close(); process.exit(2); }
await new Promise(r => setTimeout(r, 1500));

// ---- rig facts, once ----
const facts = await page.evaluate(() => {
  const T = window.__COW.THREE;
  const hero = window.__COW.state.hero;
  const p = window.__COW.player;
  const rig = p.anim.rig;
  const out = { bones: {}, ok: rig.ok, heroScale: hero.scale.toArray(), heroPos: hero.position.toArray() };
  const v = new T.Vector3();
  for (const n of Object.keys(rig.b)) {
    rig.b[n].getWorldPosition(v);
    out.bones[n] = v.toArray().map(x => +x.toFixed(4));
  }
  out.legLength = p.anim.legLength;
  out.strideAmp = p.anim.t.strideAmp;
  out.hipsRestY = rig.hipsRestY;
  // world-space bone scale
  const s = new T.Vector3();
  rig.b.Hips.getWorldScale(s);
  out.hipsWorldScale = s.toArray();
  // arena floor y under hero
  out.playerSpeedConst = p.speed;
  out.playerMass = p.mass;
  const z = window.__COW.enemies[0];
  if (z) { out.zombieMass = z.mass; out.zombieSpeed = z.speed; out.zombieScale = z.root.scale.toArray(); }
  return out;
});
fs.writeFileSync(path.join(OUT, 'rig_facts.json'), JSON.stringify(facts, null, 2));

// ---- install per-rAF sampler ----
await page.evaluate(() => {
  const T = window.__COW.THREE;
  window.__P = [];
  const v = new T.Vector3(), v2 = new T.Vector3(), v3 = new T.Vector3();
  const q = new T.Quaternion();
  window.__MARK = '';
  const sample = () => {
    const C = window.__COW;
    const p = C.player;
    if (!p) return;
    const rig = p.anim && p.anim.rig;
    const row = {
      t: performance.now(),
      mark: window.__MARK,
      pos: p.root.position.toArray().map(n => +n.toFixed(5)),
      vel: +p.vel.length().toFixed(4),
      velv: p.vel.toArray().map(n => +n.toFixed(4)),
      st: p.state,
      hp: +p.hp.toFixed(1),
      phase: p.anim ? +p.anim.phase.toFixed(4) : 0,
      aspd: p.anim ? +p.anim._speed.toFixed(4) : 0,
      face: +p.face.toFixed(4),
      combo: p.combo,
      pt: +p.t.toFixed(4),
    };
    if (rig && rig.b.LeftFoot) {
      rig.b.LeftFoot.getWorldPosition(v); row.lf = v.toArray().map(n => +n.toFixed(5));
      rig.b.RightFoot.getWorldPosition(v); row.rf = v.toArray().map(n => +n.toFixed(5));
      rig.b.LeftToeBase.getWorldPosition(v); row.lt = v.toArray().map(n => +n.toFixed(5));
      rig.b.RightToeBase.getWorldPosition(v); row.rt = v.toArray().map(n => +n.toFixed(5));
      rig.b.Hips.getWorldPosition(v); row.hip = v.toArray().map(n => +n.toFixed(5));
      rig.b.RightHand.getWorldPosition(v); row.rh = v.toArray().map(n => +n.toFixed(5));
      rig.b.Head.getWorldPosition(v); row.hd = v.toArray().map(n => +n.toFixed(5));
      // deviation from bind pose: sum of angle between current and rest quat
      let dev = 0, devArm = 0;
      for (const n of Object.keys(rig.b)) {
        const a = rig.b[n].quaternion.angleTo(rig.rest[n]);
        dev += a;
        if (n.indexOf('Arm') >= 0 || n.indexOf('Shoulder') >= 0) devArm += a;
      }
      row.dev = +dev.toFixed(4);
      row.devArm = +devArm.toFixed(4);
    }
    // weapon tip
    const wep = window.__COW.state.weapon;
    if (wep) {
      wep.getWorldPosition(v);
      // approximate tip: local +Y 0.9 in pivot space
      v2.set(0, 0.9, 0).applyMatrix4(wep.matrixWorld);
      row.wtip = v2.toArray().map(n => +n.toFixed(4));
    }
    // enemies
    row.e = C.enemies.map(e => {
      const r = {
        p: e.root.position.toArray().map(n => +n.toFixed(4)),
        v: +e.vel.length().toFixed(4),
        d: e.dead ? 1 : 0,
        dt: +(e._deathT || 0).toFixed(3),
        s: e.state,
        tok: e.hasToken ? 1 : 0,
        stag: +(e.stagger || 0).toFixed(3),
        hp: +e.hp.toFixed(1),
        ry: +e.root.rotation.y.toFixed(3),
        py: +e.root.position.y.toFixed(4),
        rad: e.radius,
      };
      if (e.anim && e.anim.rig && e.anim.rig.b.LeftFoot) {
        e.anim.rig.b.LeftFoot.getWorldPosition(v3);
        r.lf = v3.toArray().map(n => +n.toFixed(4));
      }
      return r;
    });
    window.__P.push(row);
  };
  const loop = () => { sample(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
});

const key = async (k, down) => { down ? await page.keyboard.down(k) : await page.keyboard.up(k); };
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const mark = (m) => page.evaluate((x) => { window.__MARK = x; }, m);

const SCRIPTS = {
  // Straight run at constant input: the primary foot-slide test.
  run: async () => { await mark('run'); await key('KeyW', true); await wait(SECS * 1000); },
  // Start / stop ramp: instant accel or decel is the classic weightlessness tell.
  ramp: async () => {
    await mark('idle'); await wait(600);
    await mark('accel'); await key('KeyW', true); await wait(1400);
    await mark('cruise'); await wait(600);
    await mark('decel'); await key('KeyW', false); await wait(1400);
  },
  // Hard 180: does the body lead or snap?
  turn: async () => {
    await mark('fwd'); await key('KeyW', true); await wait(1200);
    await mark('rev'); await key('KeyW', false); await key('KeyS', true); await wait(1500);
  },
  strafe: async () => { await mark('strafe'); await key('KeyD', true); await wait(SECS * 1000); },
  combat: async () => {
    await mark('approach'); await key('KeyW', true); await wait(1000); await key('KeyW', false);
    await wait(200);
    for (let i = 0; i < 3; i++) {
      await mark('hit' + i);
      await page.mouse.click(W / 2, H / 2);
      await wait(500);
    }
    await mark('after'); await wait(800);
  },
  dodge: async () => {
    await mark('pre'); await key('KeyW', true); await wait(700);
    await mark('roll'); await page.keyboard.press('Space');
    await wait(1600);
  },
  death: async () => {
    await mark('approach'); await key('KeyW', true); await wait(1200); await key('KeyW', false);
    for (let i = 0; i < 10; i++) { await page.mouse.click(W / 2, H / 2); await wait(320); }
    await mark('settle'); await wait(2500);
  },
  // Long observation of the pack with no player input.
  crowd: async () => { await mark('crowd'); await wait(SECS * 1000); },
  // Drive into the arena edge with the pack following: collision stress.
  corner: async () => {
    await mark('toedge'); await key('KeyW', true); await wait(6000);
    await mark('pinned'); await wait(6000);
  },

  // Guaranteed contact. Player input alone whiffs (camera-relative forward has
  // no relation to where an enemy is), so place the hero in reach and facing
  // the nearest living draugr before each click. Harness-side placement only —
  // the game's own attack, hit, knockback and death paths all run untouched.
  strike: async () => {
    for (let i = 0; i < 12; i++) {
      await page.evaluate(() => {
        const C = window.__COW, p = C.player;
        let best = null, bd = 1e9;
        for (const e of C.enemies) {
          if (e.dead) continue;
          const d = e.root.position.distanceTo(p.root.position);
          if (d < bd) { bd = d; best = e; }
        }
        if (!best) return;
        const T = C.THREE;
        const dir = new T.Vector3().subVectors(best.root.position, p.root.position).setY(0).normalize();
        p.root.position.copy(best.root.position).addScaledVector(dir, -1.5).setY(0);
        p.face = Math.atan2(dir.x, dir.z);
        p.root.rotation.y = p.face + Math.PI;
        p.vel.set(0, 0, 0);
      });
      await mark('swing' + i);
      await page.mouse.click(W / 2, H / 2);
      await wait(600);
    }
    await mark('settle'); await wait(3000);
  },

  // Force the pin the player cannot reach on their own: park the hero on the
  // arena bound and drag the whole pack onto him.
  pin: async () => {
    await mark('setup');
    await page.evaluate(() => {
      const C = window.__COW, p = C.player;
      p.root.position.set(8.9, 0, 0);
      C.enemies.forEach((e, i) => {
        const a = (i / C.enemies.length) * Math.PI * 2;
        e.root.position.set(8.9 + Math.cos(a) * 1.0, 0, Math.sin(a) * 1.0);
      });
    });
    await mark('pinned'); await key('KeyD', true); await wait(8000);
  },
};

const STRIP = Number(arg('strip', 0));   // frames to grab alongside the script
const runner = (SCRIPTS[SCRIPT] || SCRIPTS.run)();
if (STRIP > 0) {
  const gap = Number(arg('gap', 70));
  for (let i = 0; i < STRIP; i++) {
    await page.screenshot({ path: path.join(OUT, String(i).padStart(3, '0') + '.png') });
    await wait(gap);
  }
}
await runner;
const data = await page.evaluate('JSON.stringify(window.__P)');
fs.writeFileSync(path.join(OUT, 'probe.json'), data);
const n = JSON.parse(data).length;
await browser.close();
console.log(`${n} samples -> ${path.join(OUT, 'probe.json')}`);
