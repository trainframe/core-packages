// @ts-check
/**
 * Render a SINGLE hi-res showcase video stitching the best parts of the simulator
 * together. Records a curated, ordered list of `?physics=<name>` scenes at 1080p,
 * trims each to a punchy window, and concatenates them into one MP4.
 *
 *   pnpm --filter @trainframe/ui-tests exec node scripts/showcase-video.mjs
 *
 * Prereq: the sim-ui dev server on :5274 (override with TF_URL). Needs ffmpeg.
 * Output: videos/showcase/trainframe-showcase.mp4 (+ the per-scene webms).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const BASE = process.env.TF_URL ?? 'http://localhost:5274/';
const OUT = new URL('../videos/showcase/', import.meta.url).pathname;
const W = 1920;
const H = 1080;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => process.stdout.write(`[showcase] ${m}\n`);

/* The curated reel, in order — each `secs` is the highlight window to capture. */
const REEL = [
  {
    name: 'railyard',
    secs: 30,
    caption: 'CV-driven railyard: camera reads the rake, crane wedge decouples, points route it',
  },
  {
    name: 'depot',
    secs: 34,
    caption: 'Depot roundhouse: a nested zone — the turntable serves each loco onto a stall',
  },
  {
    name: 'turntable',
    secs: 24,
    caption: 'Turntable: the deck physically turns the loco around (honest 8-way)',
  },
  {
    name: 'crane-drop',
    secs: 12,
    caption: 'Dock jib drops a crate on the line — the train derails on it',
  },
  {
    name: 'lift-bridge',
    secs: 13,
    caption: 'Lift bridge: the span breaks the track; the train is held, then crosses',
  },
  { name: 'headon', secs: 7, caption: 'Momentum: an uneven head-on shoves the lighter loco back' },
  { name: 'load', secs: 7, caption: 'Tractive load: fewer carriages run ahead' },
  { name: 'derail', secs: 6, caption: 'Derail: too fast through a tight curve' },
];

async function recordScene(browser, scene, index) {
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    recordVideo: { dir: OUT, size: { width: W, height: H } },
  });
  const page = await context.newPage();
  await page.goto(`${BASE}?physics=${scene.name}`, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-testid="physics-canvas"]', { timeout: 10000 });
  await page.waitForFunction(() => !!window.__tfPhysics, undefined, { timeout: 10000 });
  await sleep(scene.secs * 1000);
  const video = page.video();
  await context.close();
  if (!video) throw new Error(`no video for ${scene.name}`);
  const dest = `${OUT}${String(index).padStart(2, '0')}-${scene.name}.webm`;
  const src = await video.path();
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', src, '-c', 'copy', dest]);
  rmSync(src, { force: true });
  log(`recorded ${scene.name} (${scene.secs}s) → ${dest}`);
  return dest;
}

async function main() {
  /* Names on the CLI override the reel; `name:secs` sets a per-scene duration
     (e.g. `node showcase-video.mjs spectacle:160` records spectacle for 160s). */
  const argv = process.argv.slice(2);
  const reel = argv.length
    ? argv.map((arg) => {
        const [name, s] = arg.split(':');
        return { name, secs: s ? Number(s) : 5, caption: name };
      })
    : REEL;
  /* Fresh output dir so stale per-scene clips never sneak into the concat. */
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const clips = [];
  for (let i = 0; i < reel.length; i++) {
    const scene = reel[i];
    if (scene) clips.push(await recordScene(browser, scene, i + 1));
  }
  await browser.close();

  /* Concat → one 1080p MP4. Re-encode (not stream-copy) so the per-clip VP8s join
     cleanly into a single H.264 file regardless of small param drift. */
  const listFile = `${OUT}concat.txt`;
  writeFileSync(listFile, clips.map((c) => `file '${c}'`).join('\n'));
  const finalMp4 = `${OUT}trainframe-showcase.mp4`;
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    listFile,
    '-vf',
    `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,fps=30`,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-crf',
    '20',
    finalMp4,
  ]);
  log(
    `=== showcase → ${finalMp4} (${readdirSync(OUT).filter((f) => f.endsWith('.webm')).length} scenes) ===`,
  );
}

main().catch((e) => {
  process.stderr.write(`${e?.stack ?? e}\n`);
  process.exit(1);
});
