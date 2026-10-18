// Implements [WEB-DESIGN-MEDIA]. Shoots and publishes one walkthrough film from
// films/<film>.mjs. See README.md.
//
//   make _build-vsix VSIX_PREBUILT=1
//   node src/website/tools/profiler-film/film.mjs <film>              (shoot, then publish)
//   node src/website/tools/profiler-film/film.mjs <film> --publish    (publish the last shoot)
//
// A shoot lands in out/<film>/ (gitignored); publishing writes the site's video,
// poster, captions and stills under src/website/src/assets.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { out as filmsOut, publishStills } from './kit/encode.mjs';
import { publishWalkthrough, shootWalkthrough } from './kit/scenes.mjs';

const films = path.join(path.dirname(fileURLToPath(import.meta.url)), 'films');
const available = fs.readdirSync(films).filter((file) => file.endsWith('.mjs')).map((file) => file.replace(/\.mjs$/, ''));
const [id] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
if (!available.includes(id)) throw new Error(`usage: film.mjs <${available.join('|')}> [--publish]`);

const film = (await import(path.join(films, `${id}.mjs`))).default;
const out = path.join(filmsOut, id);
const narration = film.narration && JSON.parse(fs.readFileSync(path.join(films, film.narration), 'utf8'));

if (!process.argv.includes('--publish')) await shootWalkthrough({ demo: film.demo, out, scenes: film.scenes, settings: film.settings });
const length = await publishWalkthrough({ name: film.name, out, scenes: film.scenes, posterAt: film.poster, narration });
if (fs.existsSync(path.join(out, 'stills'))) publishStills(path.join(out, 'stills'));
process.stdout.write(`${film.name}: ${length.toFixed(1)}s published\n`);
