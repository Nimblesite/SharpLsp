// Implements [WEB-DESIGN-MEDIA]. The one entry point: shoots, publishes or previews
// any film by the name of its folder in films/. What a film's film.mjs exports
// makes it one of three kinds (README.md):
//
//   scenes             a walkthrough: shot in a real editor, cut through the camera
//   lesson             a lesson: slides around footage cut from published walkthroughs
//   shoot, publish     a composite: its own shoot, and its own page rendered over it
//
//   make _build-vsix VSIX_PREBUILT=1
//   node src/website/tools/video/film.mjs <film>                  (shoot, then publish)
//   node src/website/tools/video/film.mjs <film> --publish        (publish the last shoot)
//   node src/website/tools/video/film.mjs <film> --preview 2,30   (stills at those seconds: lessons, composites)
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
/** Every film is a folder of its own, `films/<film>/`, holding its `film.mjs` and anything it reads. */
const available = fs.readdirSync(films).filter((name) => fs.existsSync(path.join(films, name, 'film.mjs')));
const [id] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (!available.includes(id)) throw new Error(`usage: film.mjs <${available.join('|')}> [--publish | --preview <seconds,...>]`);

const folder = path.join(films, id);
const film = (await import(path.join(folder, 'film.mjs'))).default;
const out = path.join(filmsOut, id);
const narration = film.narration && JSON.parse(fs.readFileSync(path.join(folder, film.narration), 'utf8'));
const publishOnly = process.argv.includes('--publish');
const flag = process.argv.indexOf('--preview');
/** `--preview 2,30`: the seconds to draft stills at, or `undefined` to publish. */
const previewAt = flag < 0 ? undefined : process.argv[flag + 1].split(',').map(Number);
const drafted = (length) => `${length.toFixed(1)}s drafted; stills in out/${id}/preview`;
const published = (length) => `${length.toFixed(1)}s published`;

/** A walkthrough shoots its scenes, then cuts them through the camera and publishes them. */
async function walkthrough() {
  if (!publishOnly) await shootWalkthrough({ demo: film.demo, out, scenes: film.scenes, settings: film.settings });
  if (fs.existsSync(path.join(out, 'stills'))) publishStills(path.join(out, 'stills'), film.stillsFolder);
  // A film of stills alone has no clips to cut.
  if (!film.scenes.some((scene) => scene.clip)) return 'stills published';
  return published(await publishWalkthrough({ name: film.name, out, scenes: film.scenes, posterAt: film.poster, narration }));
}

/** A lesson renders from its slides and published footage: there is nothing to shoot. */
async function lesson() {
  const plan = { ...film.lesson, name: film.name, poster: film.poster, out };
  if (previewAt) return drafted(await previewLesson(plan, narration, previewAt));
  return published(await publishLesson(plan, narration));
}

/** A composite brings its own shoot, publish and preview. */
async function composite() {
  if (previewAt) return drafted(await film.preview(out, previewAt));
  if (!publishOnly) await film.shoot(out);
  return published(await film.publish(out));
}

/** A film's kind is what its film.mjs exports. */
function kindOf() {
  if (film.scenes) return walkthrough;
  if (film.lesson) return lesson;
  return composite;
}

process.stdout.write(`${film.name}: ${await kindOf()()}\n`);
