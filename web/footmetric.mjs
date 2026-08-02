#!/usr/bin/env node
/**
 * Foot-planting metric — and a self-test that proves it works.
 *
 * Every slide number this project produced before now was contaminated. The old
 * metric sampled "whichever foot is lower" each frame, so at every stance switch
 * the reading jumped a whole stride length and registered as enormous velocity.
 * Three harnesses reported 53%, 132% and 163% slip for the SAME build.
 *
 * This one:
 *   - samples BOTH feet independently at frame rate (~60Hz), never "the lower one"
 *   - segments each foot's timeline into contiguous STANCE RUNS by height
 *   - measures speed only WITHIN a run, so a switch can never be sampled
 *   - discards the first and last sample of each run (touchdown and toe-off are
 *     genuinely moving; they are not the plant)
 *   - reports slip as a fraction of body speed, which is the scale-free number
 *
 * `--validate` runs two cases whose answers are known a priori:
 *   STATIONARY   body still, animation running  -> slip must be ~0
 *   FROZEN POSE  body moving, animation stopped -> slip must be ~100% of body
 * A metric that cannot pass both is not worth tuning against, and the old one
 * could not.
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
const flag = (k) => argv.includes('--' + k);

const SECONDS = Number(arg('seconds', 5));
const BAND = Number(arg('band', 0.35));

/** Runs in the page. Returns raw per-foot samples; all analysis is done here.
 *  Must be a real function, not a string — page.evaluate treats a string as an
 *  expression to evaluate, not a callable to invoke with arguments. */
const SAMPLER = async (frames) => {
  const { player, state, THREE } = window.__COW;
  // Bone names vary by exporter: the generated rig uses `LeftFoot`, Mixamo
  // exports arrive as `mixamorigLeftFoot` (the glTF exporter drops the colon).
  const canon = (n) => String(n).replace(/^mixamorig[:_]?/i, '').replace(/^.*:/, '');
  let L = null, R = null;
  state.hero.traverse(o => {
    if (!o.isBone) return;
    const c = canon(o.name);
    if (c === 'LeftFoot') L = o;
    if (c === 'RightFoot') R = o;
  });
  if (!L || !R) return { error: 'no foot bones' };
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  const inv = new THREE.Matrix4();
  const out = [];
  let t0 = performance.now();
  let prevPos = player.root.position.clone();
  for (let i = 0; i < frames; i++) {
    await new Promise(r => requestAnimationFrame(r));
    const now = performance.now();
    const dt = (now - t0) / 1000; t0 = now;
    if (dt <= 0 || dt > 0.06) { prevPos = player.root.position.clone(); continue; }
    state.hero.updateWorldMatrix(true, true);
    L.updateWorldMatrix(true, false);
    R.updateWorldMatrix(true, false);
    a.setFromMatrixPosition(L.matrixWorld);
    b.setFromMatrixPosition(R.matrixWorld);
    // Also record each foot in CHARACTER space. World slip alone cannot say
    // WHY a foot slides; char-space travel says whether the clip is moving the
    // foot backward at all, which is the thing that has to cancel body motion.
    inv.copy(state.hero.matrixWorld).invert();
    const la = a.clone().applyMatrix4(inv);
    const rb = b.clone().applyMatrix4(inv);
    out.push({
      dt,
      l: [a.x, a.y, a.z],
      r: [b.x, b.y, b.z],
      lc: [la.x, la.y, la.z],
      rc: [rb.x, rb.y, rb.z],
      body: player.root.position.distanceTo(prevPos) / dt,
    });
    prevPos = player.root.position.clone();
  }
  return { samples: out };
};

/** Segment one foot's timeline into stance runs and measure in-run speed. */
function analyseFoot(samples, key, groundThresh, stats) {
  const speeds = [];
  let run = [];
  const flush = () => {
    if (run.length > 0 && stats) { stats.runs.push(run.length); }
    // Drop touchdown and toe-off: those frames are genuinely in motion.
    if (run.length >= 4) {
      for (let i = 2; i < run.length - 1; i++) {
        const p = run[i - 1], q = run[i];
        const d = Math.hypot(q.pos[0] - p.pos[0], q.pos[2] - p.pos[2]);
        speeds.push(d / q.dt);
      }
    }
    run = [];
  };
  for (const s of samples) {
    const pos = s[key];
    if (pos[1] <= groundThresh) run.push({ pos, dt: s.dt });
    else flush();
  }
  flush();
  return speeds;
}

function analyse(samples) {
  const ys = samples.flatMap(s => [s.l[1], s.r[1]]);
  const lo = Math.min(...ys), hi = Math.max(...ys);
  // Stance = the lowest BAND fraction of the vertical range the feet cover.
  // 0.35 was far too generous: the planted ankle sits at 0.128m and the band
  // reached 0.277m, so a foot 15cm off the floor — unambiguously mid-swing —
  // counted as stance and its swing velocity was averaged into the plant.
  const thresh = lo + (hi - lo) * BAND;
  const stats = { runs: [] };
  const sp = [...analyseFoot(samples, 'l', thresh, stats), ...analyseFoot(samples, 'r', thresh, stats)];
  // Signed char-space Z travel of the stance foot, over EXACTLY the same frames
  // the world measurement uses. Previously this included touchdown and toe-off
  // while the world figure trimmed them, so the two were not comparable and I
  // was reading a ratio between different frame sets.
  const charV = [];
  for (const [wk, ck] of [['l', 'lc'], ['r', 'rc']]) {
    let run = [];
    const flush = () => {
      if (run.length >= 4) {
        for (let i = 2; i < run.length - 1; i++) {
          charV.push((run[i].z - run[i - 1].z) / run[i].dt);
        }
      }
      run = [];
    };
    for (const s of samples) {
      if (s[wk][1] <= thresh) run.push({ z: s[ck][2], dt: s.dt });
      else flush();
    }
    flush();
  }
  const bodies = samples.map(s => s.body).filter(v => v >= 0);
  const med = (x) => { const s = [...x].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
  const p90 = (x) => { const s = [...x].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length * 0.9)] : NaN; };
  const body = med(bodies);
  return {
    n: sp.length,
    body,
    stanceP50: med(sp),
    stanceP90: p90(sp),
    slipPct: body > 0.05 ? (100 * med(sp)) / body : 0,
    footLo: lo, footHi: hi, thresh,
    charP50: med(charV),
    charN: charV.length,
    runs: stats.runs.length,
    runLenMed: med(stats.runs),
    runLenMax: stats.runs.length ? Math.max(...stats.runs) : 0,
    totalFrames: samples.length,
  };
}

async function run(page, { move, freeze, seconds }) {
  if (freeze) {
    await page.evaluate(() => {
      const p = window.__COW.player;
      const a = p.anim;
      a.__frozenUpdate = a.update;
      a.update = () => {};      // hold the pose
      // Rotation must be pinned too. A rotating body adds tangential velocity
      // at the foot on top of translation, so a frozen-pose character that is
      // also turning slides FASTER than body speed — measured 130% where the
      // control case should read exactly 100%. That was my expectation being
      // wrong, not the metric.
      p.__lockFace = p.face;
      Object.defineProperty(p, 'face', {
        get() { return this.__lockFace; },
        set() {},
        configurable: true,
      });
    });
  }
  if (move) await page.keyboard.down('KeyW');
  await new Promise(r => setTimeout(r, 1200));      // settle
  const res = await page.evaluate(SAMPLER, Math.round(seconds * 60));
  if (move) await page.keyboard.up('KeyW');
  if (freeze) {
    await page.evaluate(() => {
      const p = window.__COW.player;
      const a = p.anim;
      if (a.__frozenUpdate) { a.update = a.__frozenUpdate; delete a.__frozenUpdate; }
      const v = p.face;
      delete p.face;
      p.face = v;
    });
  }
  if (res.error) throw new Error(res.error);
  return analyse(res.samples);
}

const browser = await puppeteer.launch({
  headless: false,
  args: ['--use-angle=metal', '--enable-gpu', '--no-sandbox'],
  defaultViewport: { width: 800, height: 450 },
});
const page = await browser.newPage();
await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 180000 });
await page.waitForFunction('window.__COW_READY === true || window.__COW_ERROR', { timeout: 180000 });
await new Promise(r => setTimeout(r, 1000));

// Overrides for sweeping: --speed sets the body's target speed, --mpc pins
// metresPerCycle so the playback rate is a known constant rather than whatever
// the calibrator converged on.
const OV_SPEED = arg('speed', null), OV_MPC = arg('mpc', null);
if (flag('nolock')) await page.evaluate(() => { window.__COW_NOLOCK = 1; window.__COW.player.anim.footLock = false; });
if (OV_SPEED || OV_MPC) {
  await page.evaluate(({ sp, mpc }) => {
    const p = window.__COW.player;
    if (sp) p.speed = Number(sp);
    if (window.__COW_NOLOCK) p.anim.footLock = false;
    if (mpc) {
      p.anim.metresPerCycle = Number(mpc);
      p.anim._cal.done = true;          // stop the calibrator overwriting it
    }
  }, { sp: OV_SPEED, mpc: OV_MPC });
}

// --pinface holds the character's facing constant while the clip keeps playing.
// A rotating body adds tangential velocity at the foot on top of translation,
// and the foot sits ~0.3m off the turn axis, so a fast turn can dominate the
// reading. If slip collapses under this flag the residual was never the clip.
if (flag('pinface')) {
  await page.evaluate(() => {
    const p = window.__COW.player;
    p.__lockFace = p.face;
    Object.defineProperty(p, 'face', {
      get() { return this.__lockFace; }, set() {}, configurable: true,
    });
  });
}

if (flag('validate')) {
  console.log('\n  VALIDATING THE METRIC against known answers\n');

  const still = await run(page, { move: false, freeze: false, seconds: 2.5 });
  const stillOk = still.stanceP50 < 0.15;
  console.log(`  STATIONARY   body ${still.body.toFixed(2)} m/s  stance ${still.stanceP50.toFixed(3)} m/s`
    + `   expect ~0   ${stillOk ? 'PASS' : 'FAIL'}   (n=${still.n})`);

  const frozen = await run(page, { move: true, freeze: true, seconds: 3 });
  const frozenOk = frozen.slipPct > 88 && frozen.slipPct < 112;
  console.log(`  FROZEN POSE  body ${frozen.body.toFixed(2)} m/s  stance ${frozen.stanceP50.toFixed(2)} m/s`
    + `   slip ${frozen.slipPct.toFixed(0)}%   expect ~100%   ${frozenOk ? 'PASS' : 'FAIL'}   (n=${frozen.n})`);

  console.log(`\n  METRIC ${stillOk && frozenOk ? 'TRUSTWORTHY' : 'NOT TRUSTWORTHY'}\n`);
  await browser.close();
  process.exit(stillOk && frozenOk ? 0 : 1);
}

const r = await run(page, { move: true, freeze: false, seconds: SECONDS });
console.log(`\n  body ${r.body.toFixed(2)} m/s   usable stance samples ${r.n} of ${r.totalFrames} frames`);
console.log(`  stance runs ${r.runs}   median length ${r.runLenMed} frames   max ${r.runLenMax}`);
console.log(`  foot height range ${r.footLo.toFixed(3)} .. ${r.footHi.toFixed(3)}  (stance <= ${r.thresh.toFixed(3)})`);
console.log(`  STANCE FOOT  p50 ${r.stanceP50.toFixed(3)} m/s   p90 ${r.stanceP90.toFixed(3)} m/s`);
console.log(`  stance foot CHAR-space dz/dt  ${r.charP50.toFixed(3)} m/s`
  + `   (want +${r.body.toFixed(2)} to cancel the body)`);
console.log(`  SLIP ${r.slipPct.toFixed(0)}% of body speed   (0% = planted, 100% = skating)\n`);
fs.writeFileSync(path.join(ROOT, 'shots', 'motion', 'footmetric.json'), JSON.stringify(r, null, 2));
await browser.close();
