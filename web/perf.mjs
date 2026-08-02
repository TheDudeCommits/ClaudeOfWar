#!/usr/bin/env node
/**
 * Frame-time harness. Runs the real game in Chrome on the GPU and reports
 * percentile frame times, so "is it 30 FPS" is measured rather than guessed.
 *
 *   node perf.mjs                       # default 1920x1080
 *   node perf.mjs --w 1600 --h 900
 *   node perf.mjs --shot arena_ots --frames 400
 */
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASE = process.env.COW_URL || 'http://localhost:5173';
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const W = Number(arg('w', 1920)), H = Number(arg('h', 1080));
const FRAMES = Number(arg('frames', 300));
const SHOT = arg('shot', 'arena_ots');
const SCALE = arg('scale', null);

const browser = await puppeteer.launch({
  headless: false,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio', '--no-sandbox'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});
const page = await browser.newPage();
await page.goto(`${BASE}/?shot=${SHOT}&perf=1${SCALE ? '&scale=' + SCALE : ''}`, { waitUntil: 'networkidle2', timeout: 120000 });
await page.waitForFunction('window.__COW_READY===true || window.__COW_ERROR', { timeout: 180000 });

const err = await page.evaluate('window.__COW_ERROR || null');
if (err) { console.error('page error:', String(err).slice(0, 300)); await browser.close(); process.exit(2); }

const res = await page.evaluate(async (frames) => {
  const { post, renderer } = window.__COW;
  // Warm up: shader compiles and texture uploads on the first frames would
  // otherwise dominate the percentiles.
  for (let i = 0; i < 60; i++) {
    await new Promise(r => requestAnimationFrame(r));
    post.render(1 / 60);
  }
  const t = [];
  for (let i = 0; i < frames; i++) {
    const a = performance.now();
    post.render(1 / 60);
    await new Promise(r => requestAnimationFrame(r));
    t.push(performance.now() - a);
  }
  t.sort((x, y) => x - y);
  const p = q => t[Math.min(t.length - 1, Math.floor(t.length * q))];
  // This machine is a fanless Air. Sustained GPU benchmarking throttles it, so
  // the minimum frame time is the honest read of unthrottled cost and p50 is
  // the honest read of what a player actually gets after a few minutes.
  const info = renderer.info;
  return {
    min: t[0], p50: p(0.50), p90: p(0.90), p99: p(0.99),
    mean: t.reduce((a, b) => a + b, 0) / t.length,
    drawCalls: info.render.calls, triangles: info.render.triangles,
    programs: info.programs ? info.programs.length : -1,
    textures: info.memory.textures, geometries: info.memory.geometries,
  };
}, FRAMES);

const fps = q => (1000 / q).toFixed(1);
console.log(`\n  ${W}x${H}  scale=${SCALE ?? 'default'}  shot=${SHOT}  frames=${FRAMES}`);
console.log(`  frame time   min ${res.min.toFixed(1)}ms   p50 ${res.p50.toFixed(1)}ms   p90 ${res.p90.toFixed(1)}ms`);
console.log(`  FPS          min ${fps(res.min)}     p50 ${fps(res.p50)}      p90 ${fps(res.p90)}`);
console.log(`  draw calls ${res.drawCalls}   triangles ${res.triangles.toLocaleString()}   programs ${res.programs}`);
console.log(`  textures ${res.textures}   geometries ${res.geometries}`);
const worst = 1000 / res.p90;
console.log(`  ${worst >= 30 ? 'PASS' : 'FAIL'}: p90 is ${worst.toFixed(1)} FPS against a 30 FPS floor\n`);
await browser.close();
process.exit(worst >= 30 ? 0 : 1);
