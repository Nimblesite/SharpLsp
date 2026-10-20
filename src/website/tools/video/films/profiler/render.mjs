// Implements [WEB-DESIGN-MEDIA]. Renders the profiler film and the website's profiler media from capture.mjs's
// output: steps film.html frame by frame in headless Chromium, pipes the frames
// to ffmpeg, then writes the site assets (film MP4/WebM + poster, the unedited
// recordings + posters, WebP stills).
//
//   node src/website/tools/video/films/profiler/render.mjs
//   node src/website/tools/video/films/profiler/render.mjs --preview 2,9.5,24   (stills of those seconds)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { H264, VP9, ffmpeg, out, poster, publishStills, videos } from '../../kit/encode.mjs';
import { explode, previewFrames, renderMaster } from '../../kit/frames.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const html = path.join(here, 'film.html');
const POSTER_AT = 25.5;

/** Each clip's frame count, once exploded into out/film/<clip>/, and the click cues capture.mjs recorded. */
function filmData() {
  const clip = (name) => ({
    frames: explode(path.join(out, 'clips', `${name}.mp4`), path.join(out, 'film', name)),
    cues: JSON.parse(fs.readFileSync(path.join(out, 'clips', `${name}.cues.json`), 'utf8')),
  });
  return { cpu: clip('cpu'), memory: clip('memory') };
}

async function preview(times) {
  const duration = await previewFrames(html, 'FILM_DATA', filmData(), times, path.join(out, 'preview'));
  process.stdout.write(`film is ${duration.toFixed(1)}s; previews in out/preview\n`);
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

async function main() {
  const flag = process.argv.indexOf('--preview');
  if (flag > 0) return preview(process.argv[flag + 1].split(',').map(Number));
  fs.mkdirSync(videos, { recursive: true });
  const master = path.join(out, 'film-master.mp4');
  const duration = await renderMaster(html, 'FILM_DATA', filmData(), master);
  publishFilm(master);
  publishRecordings();
  publishStills(path.join(out, 'stills'));
  process.stdout.write(`rendered ${duration.toFixed(1)}s film and the profiler media\n`);
}

await main();
