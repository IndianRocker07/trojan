#!/usr/bin/env node
/**
 * Screenshot a page with headless Edge/Chrome (WebGL via SwiftShader).
 *   node scripts/shot.mjs "<url>" <out.png> [width=1400] [height=900] [waitMs=8000]
 * Example (dev server running: npm run dev -- --port 5173):
 *   node scripts/shot.mjs "http://localhost:5173/models.html?kind=hospital" shots/hospital.png
 * Then open the PNG with the Read tool to look at it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const [url, out, w = '1400', h = '900', wait = '8000'] = process.argv.slice(2);
if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [w] [h] [waitMs]');
  process.exit(1);
}
const candidates = [
  process.env.BROWSER,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
const bin = candidates.find((p) => existsSync(p));
if (!bin) {
  console.error('No Edge/Chrome found; set BROWSER=path');
  process.exit(1);
}
const abs = resolve(out);
mkdirSync(dirname(abs), { recursive: true });
if (existsSync(abs)) rmSync(abs);
const profile = resolve(tmpdir(), `trojan-shot-${process.pid}-${Date.now()}`);
const r = spawnSync(
  bin,
  [
    '--headless=new',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--window-size=${w},${h}`,
    `--virtual-time-budget=${wait}`,
    `--screenshot=${abs}`,
    url,
  ],
  { encoding: 'utf8', timeout: 180000 },
);
try {
  rmSync(profile, { recursive: true, force: true });
} catch {}
if (!existsSync(abs)) {
  console.error('screenshot failed', (r.stderr || '').slice(-2000));
  process.exit(1);
}
console.log('wrote', abs);
