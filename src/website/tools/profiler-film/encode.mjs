// Implements [WEB-DESIGN-MEDIA]. How every profiler video reaches the site: one
// H.264 and one VP9 setting, a WebP poster per video, WebP stills.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const out = path.join(here, 'out');
export const videos = path.resolve(here, '../../src/assets/videos');

/** H.264 for reach: every site video has an MP4. */
export const H264 = ['-c:v', 'libx264', '-preset', 'veryslow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an'];
/** VP9 for size: the WebM a browser prefers when it can play it. */
export const VP9 = ['-c:v', 'libvpx-vp9', '-crf', '40', '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2', '-an'];

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
}
