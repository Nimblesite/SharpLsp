// Implements [WEB-DESIGN-MEDIA]. Composited films are web pages whose every frame
// is a pure function of t: `window.renderFrame(t)` sets the page and resolves once
// its images are decoded. This steps such a page in headless Chromium and pipes
// each frame, losslessly, into a master encode; `explode` turns footage into the
// numbered JPEGs those pages step through.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { ffmpeg } from './encode.mjs';

export const FPS = 30;
const VIEWPORT = { width: 1920, height: 1080 };

/** `video` (optionally `filter`ed) as `dir/00001.jpg` onwards at FPS; returns the frame count. */
export function explode(video, dir, filter = '') {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  ffmpeg(['-i', video, '-vf', [`fps=${FPS}`, filter].filter(Boolean).join(','), '-q:v', '2', path.join(dir, '%05d.jpg')], path.basename(dir));
  return fs.readdirSync(dir).filter((file) => file.endsWith('.jpg')).length;
}

/** Open `html` with `data` as `window[global]`; resolves to the page and the length it reports as FILM_DURATION. */
export async function openFilm(browser, html, global, data) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  await page.addInitScript(([name, value]) => {
    window[name] = value;
  }, [global, data]);
  await page.goto(`file://${html}`);
  await page.evaluate(() => document.fonts.ready);
  return { page, duration: await page.evaluate(() => window.FILM_DURATION) };
}

/** A lossless H.264 encoder reading PNG frames from its stdin. */
function encoder(master) {
  const args = ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p', master];
  const child = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`master encode exited ${code}`)))));
  return { stdin: child.stdin, done };
}

/** Step `page` through `duration` seconds into `master`. */
async function step(page, duration, master) {
  const { stdin, done } = encoder(master);
  for (let frame = 0; frame < Math.ceil(duration * FPS); frame++) {
    await page.evaluate((t) => window.renderFrame(t), frame / FPS);
    if (!stdin.write(await page.screenshot({ type: 'png' }))) await new Promise((resolve) => stdin.once('drain', resolve));
  }
  stdin.end();
  await done;
}

/** Render the film page `html`, given `data` as `window[global]`, into the silent `master`; resolves to its length. */
export async function renderMaster(html, global, data, master) {
  const browser = await chromium.launch();
  try {
    const { page, duration } = await openFilm(browser, html, global, data);
    await step(page, duration, master);
    return duration;
  } finally {
    await browser.close();
  }
}

/** PNG stills of the film page at each of `times` into `dir`; resolves to the film's length. */
export async function previewFrames(html, global, data, times, dir) {
  const browser = await chromium.launch();
  try {
    const { page, duration } = await openFilm(browser, html, global, data);
    fs.mkdirSync(dir, { recursive: true });
    for (const t of times) {
      await page.evaluate((at) => window.renderFrame(at), t);
      await page.screenshot({ path: path.join(dir, `${t}.png`) });
    }
    return duration;
  } finally {
    await browser.close();
  }
}
