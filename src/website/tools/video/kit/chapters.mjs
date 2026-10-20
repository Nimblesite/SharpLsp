// Implements [WEB-DESIGN-MEDIA-CHAPTERS]. A film's chapters: each run of its cut
// that shows one step of the VS Code tutorial ([TUTORIAL-STEPS]), published as
// `<name>.chapters.vtt` beside its video, so the tutorial plays that step's run alone.
import fs from 'node:fs';
import path from 'node:path';
import { videos } from './encode.mjs';
import { webVtt } from './vtt.mjs';

/** The second of the cut at which shot `index` starts: every shot before it, played and held. */
export const startOf = (shots, index) => shots.slice(0, index).reduce((total, shot) => total + shot.length + (shot.hold ?? 0), 0);

/** Consecutive shots marked with one `chapter`, as `{ id, title, since, until }` shot indexes. */
const runsOf = (shots) =>
  shots.reduce((runs, shot, index) => {
    const last = runs.at(-1);
    if (!shot.chapter) return runs;
    if (last?.id === shot.chapter && last.until === index) return [...runs.slice(0, -1), { ...last, until: index + 1 }];
    return [...runs, { id: shot.chapter, title: shot.title ?? shot.chapter, since: index, until: index + 1 }];
  }, []);

/** Each chapter, `{ id, title, from, to }` in seconds of the cut. A chapter marked on shots apart fails the film. */
export function chaptersOf(shots) {
  const runs = runsOf(shots);
  const repeated = runs.find((run, index) => runs.findIndex((other) => other.id === run.id) !== index);
  if (repeated) throw new Error(`chapter "${repeated.id}" marks shots that are not consecutive`);
  return runs.map(({ id, title, since, until }) => ({ id, title, from: startOf(shots, since), to: startOf(shots, until) }));
}

/** The chapters track: one cue per chapter, identified by its id and titled by its first shot's caption. */
export const chaptersTrack = (chapters) => webVtt(chapters.map(({ id, title, from, to }) => ({ id, from, to, text: title })));

/** Write `<name>.chapters.vtt` beside the video; a film that marks no chapters has none. */
export function writeChapters(name, shots) {
  const file = path.join(videos, `${name}.chapters.vtt`);
  const chapters = chaptersOf(shots);
  if (chapters.length === 0) fs.rmSync(file, { force: true });
  else fs.writeFileSync(file, chaptersTrack(chapters));
  return chapters;
}
