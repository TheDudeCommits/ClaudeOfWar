#!/usr/bin/env node
/**
 * Character capture + shader probe.
 *
 * Mirrors web/capture.mjs, but injects the character material module at runtime
 * (`import('/src/chars/index.js')` inside the page) instead of relying on
 * main.js, which this agent does not own. Same renderer, same shot specs, same
 * post chain — the frames are real engine output.
 *
 * It ALSO fails the run on shader errors. A broken onBeforeCompile injection in
 * three does not throw: the program fails to link, three logs
 * "THREE.WebGLProgram: Shader Error", and the mesh silently keeps its previous
 * program. A frame can look merely "a bit flat" while hundreds of GL errors
 * scroll past, so every capture is probed.
 *
 *   node src/chars/capture_chars.mjs --round 8 --shots char_hero_closeup,arena_ots
 */
import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../..');
const BASE = process.env.COW_URL || 'http://localhost:5173';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : d; };

const W = 1920, H = 1080;
const BAD = /Shader Error|not compiled|INVALID_OPERATION|shader patch failed/i;

const round = arg('round', 'chars');
const shots = (arg('shots') || arg('shot') || 'char_hero_closeup')
  .split(',').map((s) => s.trim()).filter(Boolean);
const outDir = path.join(ROOT, 'shots', `round${round}`);
fs.mkdirSync(outDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: false,
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist',
    '--enable-webgl', `--window-size=${W},${H}`, '--hide-scrollbars',
    '--mute-audio', '--no-sandbox'],
  defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
});

let failures = 0, totalBad = 0;
for (const shot of shots) {
  const out = arg('out') || path.join(outDir, shot + '.png');
  const page = await browser.newPage();
  const bad = [], info = [];
  page.on('console', (m) => {
    const t = `[${m.type()}] ${m.text()}`;
    if (BAD.test(t)) bad.push(t);
    if (t.includes('[chars]')) info.push(t);
  });
  page.on('pageerror', (e) => bad.push('PAGEERROR ' + e.message));

  try {
    await page.goto(`${BASE}/?shot=${encodeURIComponent(shot)}`,
      { waitUntil: 'networkidle2', timeout: 120000 });
    await page.waitForFunction('window.__COW_READY === true || window.__COW_ERROR',
      { timeout: 180000 });
    const err = await page.evaluate('window.__COW_ERROR || null');
    if (err) throw new Error('page error: ' + err);

    const diag = await page.evaluate(async (shotName) => {
      const m = await import('/src/chars/index.js?t=' + Date.now());
      const s = window.__COW.state;
      if (s.hero) m.setupHeroMaterials(s.hero);
      if (s.zombie) m.setupZombieMaterials(s.zombie);
      const spec = await (await fetch(`/shots/${shotName}.json`)).json();
      await window.__COW.applyShot(spec);
      return s.hero?.userData?.cowReport || null;
    }, shot);

    await page.evaluate((n) => window.__COW.settle(n), Number(arg('settle', '70')));
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: out, type: 'png', captureBeyondViewport: false });

    const ok = fs.existsSync(out) && fs.statSync(out).size > 5000;
    if (!ok) failures++;
    console.log(`[${ok ? 'OK ' : 'FAIL'}] ${shot} -> ${out}`);
    if (diag) console.log('       segmentation: ' + JSON.stringify(diag));
  } catch (e) {
    failures++;
    console.log(`[FAIL] ${shot}: ${e.message}`);
  } finally {
    info.forEach((l) => console.log('       ' + l));
    totalBad += bad.length;
    if (bad.length) {
      console.log(`       !! ${bad.length} SHADER/GL ERRORS`);
      bad.slice(0, 6).forEach((l) => console.log('         ' + l.slice(0, 500)));
    } else {
      console.log('       shader errors: 0');
    }
    await page.close();
  }
}
await browser.close();
process.exit(failures || totalBad ? 1 : 0);
