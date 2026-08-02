#!/usr/bin/env node
/**
 * Shot capture harness. Drives the real game in Chrome and writes PNGs.
 * Contract mirrors the previous Godot harness: --shot / --out / exit code.
 *
 *   node capture.mjs --shot arena_ots --out ../shots/round1/arena_ots.png
 *   node capture.mjs --round 2 --shots arena_ots,arena_estab
 */
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const BASE = process.env.COW_URL || 'http://localhost:5173';

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf('--' + k);
  return i >= 0 ? argv[i + 1] : d;
};
const flag = (k) => argv.includes('--' + k);
const Q = arg('q', null);   // quality preset passthrough

const W = 1920, H = 1080;

async function main() {
  const round = arg('round');
  const shots = (arg('shots') || arg('shot') || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!shots.length) { console.error('need --shot or --shots'); process.exit(2); }
  const outDir = arg('out') ? null : path.join(ROOT, 'shots', `round${round}`);
  if (outDir) fs.mkdirSync(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    // Headful gets the real Metal GPU. Headless falls back to SwiftShader, which
    // renders correctly but takes minutes per frame with this post chain.
    headless: flag('headless'),
    args: [
      '--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
      '--enable-webgl', '--enable-webgl2-compute-context',
      `--window-size=${W},${H}`, '--hide-scrollbars', '--mute-audio',
      '--no-sandbox',
    ],
    defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
  });

  let failures = 0;
  const results = {};
  for (const shot of shots) {
    const out = arg('out') || path.join(outDir, shot + '.png');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const page = await browser.newPage();
    const logs = [];
    page.on('console', m => logs.push(`[${m.type()}] ${m.text()}`));
    page.on('pageerror', e => logs.push('PAGEERROR ' + e.message));
    try {
      await page.goto(`${BASE}/?shot=${encodeURIComponent(shot)}${Q ? '&q=' + Q : ''}`,
        { waitUntil: 'networkidle2', timeout: 120000 });
      await page.waitForFunction('window.__COW_READY === true || window.__COW_ERROR',
        { timeout: 180000 });
      const err = await page.evaluate('window.__COW_ERROR || null');
      if (err) throw new Error('page error: ' + err);

      const settle = Number(arg('settle', '60'));
      await page.evaluate((n) => window.__COW.settle(n), settle);
      await new Promise(r => setTimeout(r, 400));

      await page.screenshot({ path: out, type: 'png', captureBeyondViewport: false });
      const ok = fs.existsSync(out) && fs.statSync(out).size > 5000;
      results[shot] = ok;
      console.log(`[${ok ? 'OK ' : 'FAIL'}] ${shot} -> ${out}`);
      if (!ok) failures++;
    } catch (e) {
      failures++;
      results[shot] = false;
      console.log(`[FAIL] ${shot}: ${e.message}`);
      console.log(logs.slice(-25).map(l => '  ' + l).join('\n'));
    } finally {
      await page.close();
    }
  }
  await browser.close();
  if (outDir) {
    fs.writeFileSync(path.join(outDir, 'manifest.json'),
      JSON.stringify({ round, shots: results, ts: Date.now() }, null, 2));
  }
  process.exit(failures ? 1 : 0);
}

main();
