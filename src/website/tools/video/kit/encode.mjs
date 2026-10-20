// Implements [WEB-DESIGN-MEDIA]. How every profiler video reaches the site: one
// H.264 and one VP9 setting, a WebP poster per video, WebP stills.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tool = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Every shoot's working files, gitignored: out/<film>/. */
export const out = path.join(tool, 'out');
export const videos = path.resolve(tool, '../../src/assets/videos');
/** The site's stills: a film publishes into its own folder here, `profiler` unless it names another. */
export const shots = path.resolve(tool, '../../src/assets/screenshots');

/** H.264 for reach: every site video has an MP4. */
export const H264 = ['-c:v', 'libx264', '-preset', 'veryslow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an'];
/** VP9 for size: the WebM a browser prefers when it can play it. */
export const VP9 = ['-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-an'];

/** The narrated films' sound: AAC beside H.264, Opus beside VP9. */
export const AAC = ['-c:a', 'aac', '-b:a', '160k'];
export const OPUS = ['-c:a', 'libopus', '-b:a', '128k'];

/** A video setting that keeps the soundtrack. */
export const audible = (video) => video.filter((arg) => arg !== '-an');

/** One ffprobe query of `file`, its answer as plain text. */
function probe(file, query) {
  const result = spawnSync('ffprobe', ['-v', 'error', ...query, '-of', 'csv=p=0', file], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffprobe ${file} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** The length of `file` in seconds. */
export const duration = (file) => Number(probe(file, ['-show_entries', 'format=duration']));

/** The width and height of `file`'s video, in pixels. */
export const dimensions = (file) => probe(file, ['-select_streams', 'v:0', '-show_entries', 'stream=width,height']).split(',').map(Number);

/** `dir`, emptied: a shoot or a publish starts each working folder afresh. */
export function emptyDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ffmpeg(args, label) {
  const result = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg (${label}) failed: ${result.stderr}`);
}

export function webp(source, target, width) {
  const result = spawnSync('cwebp', ['-quiet', '-q', '88', '-m', '6', '-resize', String(width), '0', source, '-o', target], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`cwebp ${source} failed: ${result.stderr}`);
}

/** `<name>-poster.webp`: the frame of `video` at `at` seconds. Every site video carries one. */
export function poster(video, at, name) {
  const frame = path.join(out, `${name}-poster.png`);
  ffmpeg(['-ss', String(at), '-i', video, '-frames:v', '1', frame], `${name} poster`);
  webp(frame, path.join(videos, `${name}-poster.webp`), 1920);
  card(frame, name);
}

/**
 * `<name>-card.jpg`: the poster frame filled and centre-cropped to 1200x630, the
 * social preview size. JPEG, because not every network reads WebP.
 * [WEB-DESIGN-MEDIA-DISCOVERY]
 */
export function card(frame, name) {
  const fill = 'scale=1200:630:force_original_aspect_ratio=increase,crop=1200:630';
  ffmpeg(['-i', frame, '-vf', fill, '-q:v', '3', path.join(videos, `${name}-card.jpg`)], `${name} card`);
}

/** Every PNG still under `dir`, as the site's 2400px WebP of the same name in `screenshots/<folder>`. */
export function publishStills(dir, folder = 'profiler') {
  const target = path.join(shots, folder);
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.png'))) {
    webp(path.join(dir, file), path.join(target, file.replace(/\.png$/, '.webp')), 2400);
  }
}
