// Implements [WEB-DESIGN-MEDIA]. A lesson is a narrated slide film that teaches one
// feature end to end. Its slides are data (deck.js draws them); its footage is cut
// from the feature's published walkthrough, so every editor frame it shows is the
// real extension, never a mock-up. Each slide holds until its lines are spoken,
// and its items appear as the line that names them starts.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { poster, videos } from '../encode.mjs';
import { FPS, explode, previewFrames, renderMaster } from '../frames.mjs';
import { narrated } from '../publish.mjs';
import { drive } from '../sound/drive.mjs';
import { timeline } from '../sound/soundtrack.mjs';
import { pacingOf } from '../sound/voice.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DECK = path.join(here, 'deck.html');
const LOGO = pathToFileURL(path.resolve(here, '../../../../src/assets/images/sharplsp-logo.svg')).href;
/** A slide with no footage is on screen at least this long; footage starts this long after its cut, and holds this long after it ends. */
const SLIDE = { least: 1.2, delay: 0.5, after: 0.6 };
/** Spoken words a second, for a draft timed without speaking. */
const DRAFT_RATE = 3;

/** `{ video, from, to, crop: [x, y, w, h], speed, label }`, cut from `<video>.mp4` into numbered frames. */
function cutFootage(out, slide) {
  const { video, from, to, crop: [x, y, w, h] } = slide.footage;
  const dir = path.join(out, 'footage', slide.id);
  const filter = `trim=start=${from}:end=${to},setpts=PTS-STARTPTS,crop=${w}:${h}:${x}:${y},scale=1190:-2:flags=lanczos`;
  const frames = explode(path.join(videos, `${video}.mp4`), dir, filter);
  return { ...slide.footage, base: pathToFileURL(dir).href, frames, delay: SLIDE.delay };
}

/** The slides with their footage cut, and the shots the soundtrack times them as. */
function prepare(out, slides) {
  const cut = slides.map((slide) => (slide.footage ? { ...slide, footage: cutFootage(out, slide) } : slide));
  const length = (slide) => (slide.footage ? SLIDE.delay + slide.footage.frames / FPS + SLIDE.after : SLIDE.least);
  return { slides: cut, shots: cut.map((slide) => ({ clip: slide.id, length: length(slide) })) };
}

/** What deck.js reads: each slide's start, end and line starts on the film's clock. */
function deck(series, slides, film) {
  const starts = film.shots.reduce((times, shot) => [...times, times.at(-1) + shot.length + shot.hold], [0]);
  return {
    series,
    logo: LOGO,
    duration: film.duration,
    beat: drive.beat,
    drums: drive.drums,
    resolve: film.lines.at(-1).start,
    slides: slides.map((slide, i) => ({ ...slide, start: starts[i], end: starts[i + 1], lines: film.lines.filter((line) => line.scene === slide.id).map((line) => line.start) })),
  };
}

/** Speak, render and publish the lesson; resolves to its length in seconds. */
export async function publishLesson({ name, series, slides, poster: posterAt, out }, script) {
  const prepared = prepare(out, slides);
  const master = path.join(out, `${name}-master.mp4`);
  const length = await narrated(name, script, prepared.shots, async (film) => {
    await renderMaster(DECK, 'LESSON', deck(series, prepared.slides, film), master);
    return master;
  });
  poster(master, posterAt, name);
  return length;
}

/** Stills of the lesson at `times`, timed from the script's word counts instead of its speech, into `<out>/preview`. */
export async function previewLesson({ series, slides, out }, script, times) {
  const prepared = prepare(out, slides);
  const takes = script.lines.map((line) => ({ ...line, length: line.en.split(' ').length / DRAFT_RATE }));
  const film = timeline(prepared.shots, takes, pacingOf(script));
  return previewFrames(DECK, 'LESSON', deck(series, prepared.slides, film), times, path.join(out, 'preview'));
}
