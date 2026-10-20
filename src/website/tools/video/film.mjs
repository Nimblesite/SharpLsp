// Implements [WEB-DESIGN-MEDIA]. Shoots and publishes one film from films/<film>.mjs:
// a walkthrough (scenes shot in a real editor) or a lesson (slides around footage
// cut from a published walkthrough). See README.md.
//
//   make _build-vsix VSIX_PREBUILT=1
//   node src/website/tools/video/film.mjs <film>              (shoot, then publish)
//   node src/website/tools/video/film.mjs <film> --publish    (publish the last shoot)
//   node src/website/tools/video/film.mjs <lesson> --preview 2,30   (a lesson's stills at those seconds)
//
// A shoot lands in out/<film>/ (gitignored); publishing writes the site's video,
// poster, captions and stills under src/website/src/assets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { out as filmsOut, publishStills } from './kit/encode.mjs';
import { previewLesson, publishLesson } from './kit/lesson/lesson.mjs';
import { publishWalkthrough, shootWalkthrough } from './kit/scenes.mjs';

const films = path.join(path.dirname(fileURLToPath(import.meta.url)), 'films');
const available = fs.readdirSync(films).filter((file) => file.endsWith('.mjs')).map((file) => file.replace(/\.mjs$/, ''));
const [id] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (!available.includes(id)) throw new Error(`usage: film.mjs <${available.join('|')}> [--publish | --preview <seconds,...>]`);

const film = (await import(path.join(films, `${id}.mjs`))).default;
const out = path.join(filmsOut, id);
const narration = film.narration && JSON.parse(fs.readFileSync(path.join(films, film.narration), 'utf8'));

/** A lesson renders from its slides: `--preview` writes stills at the given seconds, otherwise it publishes. */
async function lesson() {
  const preview = process.argv.indexOf('--preview');
  const plan = { ...film.lesson, name: film.name, poster: film.poster, out };
  if (preview < 0) return `${film.name}: ${(await publishLesson(plan, narration)).toFixed(1)}s published`;
  const times = process.argv[preview + 1].split(',').map(Number);
  return `${film.name}: ${(await previewLesson(plan, narration, times)).toFixed(1)}s drafted; stills in out/${id}/preview`;
}

/** A walkthrough shoots its scenes, then cuts and publishes them. */
async function walkthrough() {
  if (!process.argv.includes('--publish')) await shootWalkthrough({ demo: film.demo, out, scenes: film.scenes, settings: film.settings });
  if (fs.existsSync(path.join(out, 'stills'))) publishStills(path.join(out, 'stills'), film.stillsFolder);
  // A film of stills alone has no clips to cut.
  if (film.scenes.some((scene) => scene.clip)) {
    const length = await publishWalkthrough({ name: film.name, out, scenes: film.scenes, posterAt: film.poster, narration });
    process.stdout.write(`${film.name}: ${length.toFixed(1)}s published\n`);
  } else process.stdout.write(`${film.name}: stills published\n`);
}

if (film.lesson) process.stdout.write(`${await lesson()}\n`);
else await walkthrough();
