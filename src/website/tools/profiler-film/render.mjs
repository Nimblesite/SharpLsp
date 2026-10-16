// Implements [WEB-DESIGN-MEDIA]. Renders the profiler film and the website's profiler media from capture.mjs's
// output: steps film.html frame by frame in headless Chromium, pipes the frames
// to ffmpeg, then writes the site assets (film MP4/WebM + poster, the unedited
// recordings + posters, WebP stills).
//
//   node src/website/tools/profiler-film/render.mjs
//   node src/website/tools/profiler-film/render.mjs --preview 2,9.5,24   (stills of those seconds)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { H264, VP9, ffmpeg, out, poster, videos, webp } from './encode.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = path.resolve(here, '../../src/assets/screenshots/profiler');
const FPS = 30;
const POSTER_AT = 25.5;

/** Explode a clip into numbered JPEGs the film steps through; returns the frame count. */
function explode(name) {
  const dir = path.join(out, 'film', name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  ffmpeg(['-i', path.join(out, 'clips', `${name}.mp4`), '-vf', `fps=${FPS}`, '-q:v', '2', path.join(dir, '%05d.jpg')], name);
  return fs.readdirSync(dir).filter((file) => file.endsWith('.jpg')).length;
}

function filmData() {
  const clip = (name) => ({
    frames: explode(name),
    cues: JSON.parse(fs.readFileSync(path.join(out, 'clips', `${name}.cues.json`), 'utf8')),
  });
  return { cpu: clip('cpu'), memory: clip('memory') };
}

/** Open the film page with the clips' data; resolves to the page and the film's length. */
async function openFilm(browser) {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  await page.addInitScript((film) => {
    window.FILM_DATA = film;
  }, filmData());
  await page.goto(`file://${path.join(here, 'film.html')}`);
  await page.evaluate(() => document.fonts.ready);
  const [duration, scenes] = await page.evaluate(() => [window.FILM_DURATION, window.FILM_SCENES]);
  process.stdout.write(`${JSON.stringify(scenes)}\n`);
  return { page, duration };
}

async function preview(times) {
  const browser = await chromium.launch();
  const { page, duration } = await openFilm(browser);
  fs.mkdirSync(path.join(out, 'preview'), { recursive: true });
  for (const t of times) {
    await page.evaluate((at) => window.renderFrame(at), t);
    await page.screenshot({ path: path.join(out, 'preview', `${t}.png`) });
  }
  await browser.close();
  process.stdout.write(`film is ${duration.toFixed(1)}s; previews in out/preview\n`);
}

/** Step the film and pipe every frame, losslessly, into the master encode. */
async function renderMaster(master) {
  const browser = await chromium.launch();
  const { page, duration } = await openFilm(browser);
  const encoder = spawn('ffmpeg', [
    '-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '12', '-pix_fmt', 'yuv420p', master,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => encoder.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`master encode exited ${code}`)))));
  for (let frame = 0; frame < Math.ceil(duration * FPS); frame++) {
    await page.evaluate((t) => window.renderFrame(t), frame / FPS);
    if (!encoder.stdin.write(await page.screenshot({ type: 'png' }))) await new Promise((r) => encoder.stdin.once('drain', r));
  }
  encoder.stdin.end();
  await done;
  await browser.close();
  return duration;
}

/** The site's film: H.264 for reach, VP9 for size, and a poster frame. */
function publishFilm(master) {
  ffmpeg(['-i', master, ...H264, path.join(videos, 'profiler-film.mp4')], 'film mp4');
  ffmpeg(['-i', master, ...VP9, path.join(videos, 'profiler-film.webm')], 'film webm');
  poster(master, POSTER_AT, 'profiler-film');
}

/** The unedited recordings: CPU in real time, memory as a 3x time-lapse. */
function publishRecordings() {
  ffmpeg(['-i', path.join(out, 'clips/cpu.mp4'), '-vf', 'scale=1920:-2:flags=lanczos', ...H264, path.join(videos, 'profiler-cpu-recording.mp4')], 'cpu recording');
  ffmpeg(['-i', path.join(out, 'clips/memory.mp4'), '-vf', 'setpts=PTS/3,fps=30,scale=1920:-2:flags=lanczos', ...H264, path.join(videos, 'profiler-memory-timelapse.mp4')], 'memory recording');
  poster(path.join(videos, 'profiler-cpu-recording.mp4'), 16, 'profiler-cpu-recording');
  poster(path.join(videos, 'profiler-memory-timelapse.mp4'), 14, 'profiler-memory-timelapse');
}

function publishStills() {
  for (const file of fs.readdirSync(path.join(out, 'stills')).filter((name) => name.endsWith('.png'))) {
    webp(path.join(out, 'stills', file), path.join(shots, file.replace(/\.png$/, '.webp')), 2400);
  }
}

async function main() {
  const flag = process.argv.indexOf('--preview');
  if (flag > 0) return preview(process.argv[flag + 1].split(',').map(Number));
  for (const dir of [videos, shots]) fs.mkdirSync(dir, { recursive: true });
  const master = path.join(out, 'film-master.mp4');
  const duration = await renderMaster(master);
  publishFilm(master);
  publishRecordings();
  publishStills();
  process.stdout.write(`rendered ${duration.toFixed(1)}s film and the profiler media\n`);
}

await main();
