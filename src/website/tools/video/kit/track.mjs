// Implements [WEB-DESIGN-MEDIA-CAMERA]. What the camera follows. While a clip
// records, the workbench samples twenty times a second where the film's pointer
// and the editor's text cursor are, and every widget the editor has open beside
// them, and logs each step caption with its time. kit/zoom.mjs frames the cut
// from this track; nothing here changes what the editor shows.
import fs from 'node:fs';

/** Where the pointer's tip sits in its 28px arrow: the point it points at. */
export const TIP = { x: 3, y: 2 };

/**
 * What the editor opens that the camera keeps in frame, each with how long it
 * must stay open, in seconds, before it is framed. The palette passes through
 * most acts (Go to Line, Quick Open, a command), so it is framed only when a
 * film dwells on it.
 */
export const WIDGETS = [
  ['.monaco-hover:not(.hidden)', 0.2],
  ['.editor-widget.suggest-widget.visible', 0.2],
  ['.suggest-details-container', 0.2],
  ['.parameter-hints-widget.visible', 0.2],
  ['.rename-box', 0.2],
  ['.action-widget', 0.2],
  ['.monaco-menu', 0.2],
  ['.peekview-widget', 0.2],
  ['.monaco-editor-overlaymessage', 0.2],
  ['.monaco-dialog-box', 0.2],
  ['.settings-editor', 0.2],
  ['.part.panel', 0.4],
  ['.quick-input-widget', 1],
];

const EVERY_MS = 50;

/**
 * In the workbench: sample into `window.filmTrack` every `every` ms. A sample is
 * `{ t, p, c, w }`: the time (ms since the epoch), the pointer's tip `[x, y]`, the
 * focused editor's cursor `[x, y, width, height]`, and each open widget as
 * `[index into WIDGETS, x, y, width, height]`, all in page pixels.
 */
function sampleInPage({ selectors, every, tip }) {
  const rect = (element) => {
    const box = element.getBoundingClientRect();
    return [box.x, box.y, box.width, box.height].map(Math.round);
  };
  const shown = (element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && rect(element)[2] > 0;
  const pointer = (arrow) => (arrow && shown(arrow) ? [rect(arrow)[0] + tip.x, rect(arrow)[1] + tip.y] : null);
  const cursor = () => [...document.querySelectorAll('.monaco-editor.focused .cursors-layer .cursor')].map(rect).find((box) => box[3] > 0) ?? null;
  const open = () => selectors.flatMap((selector, index) => [...document.querySelectorAll(selector)].filter(shown).map((element) => [index, ...rect(element)]));
  const sample = () => ({ t: Date.now(), p: pointer(document.getElementById('film-pointer')), c: cursor(), w: open() });
  const track = { size: [innerWidth, innerHeight], samples: [], captions: [] };
  track.timer = setInterval(() => track.samples.push(sample()), every);
  window.filmTrack = track;
}

/** In the workbench: stop sampling and hand the track back. */
function finishInPage() {
  const { timer, ...track } = window.filmTrack;
  clearInterval(timer);
  delete window.filmTrack;
  return track;
}

/** Start sampling `page` for the clip about to record. */
export const startTrack = (page) =>
  page.evaluate(sampleInPage, { selectors: WIDGETS.map(([selector]) => selector), every: EVERY_MS, tip: TIP });

/** Stop sampling `page`; resolves to its track. */
export const stopTrack = (page) => page.evaluate(finishInPage);

/** Log `caption` (`{ step, text, speed }`) at this moment of the clip recording on `page`. */
export const logCaption = (page, caption) =>
  page.evaluate((entry) => {
    if (!window.filmTrack) throw new Error(`caption "${entry.text}" is outside a clip`);
    window.filmTrack.captions.push({ t: Date.now(), ...entry });
  }, caption);

/**
 * Write `track` to `file` with its times in seconds from `start`, the clip's
 * first frame (seconds since the epoch). Samples taken before that frame keep
 * their negative times: they say where everything was when the clip began.
 */
export function saveTrack(track, start, file) {
  const at = (ms) => Number((ms / 1000 - start).toFixed(3));
  const rebase = (entries) => entries.map((entry) => ({ ...entry, t: at(entry.t) }));
  fs.writeFileSync(file, JSON.stringify({ size: track.size, samples: rebase(track.samples), captions: rebase(track.captions) }));
}

/** A clip's saved track. A clip shot before tracks existed has none, and must be shot again. */
export function readTrack(file) {
  if (!fs.existsSync(file)) throw new Error(`${file} is missing: shoot the film again, so the camera has a track to follow`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
