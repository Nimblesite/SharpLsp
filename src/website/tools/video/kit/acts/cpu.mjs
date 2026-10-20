// Implements [WEB-DESIGN-MEDIA]. The CPU act as scenes: profile the running
// demo, let it sample (fast-forwarded), stop on the heat map, then read the
// results panel. A film tells it in its own words (`story`), on its own file.
import { still } from '../camera.mjs';
import { caption, ringClick } from '../overlay.mjs';
import { startOnRow } from '../scenes.mjs';
import { awaitResults, headerButton, scrollDashboard, sleep, toggleMaximised, toggleSideBar } from '../workbench.mjs';

const SAMPLE_SECONDS = 8;
const RESULTS = 'SharpLsp Profiler';

/**
 * After a CPU stop: `<prefix>-results`, the results panel maximised, and
 * `<prefix>-heatmap`, `file` maximised with its heat bars and no side bar.
 */
export async function cpuStills(page, dir, file, prefix) {
  await toggleMaximised(page, RESULTS);
  await still(page, dir, `${prefix}-results`);
  await toggleMaximised(page, RESULTS);
  await toggleMaximised(page, file);
  await toggleSideBar(page);
  await still(page, dir, `${prefix}-heatmap`);
  await toggleSideBar(page);
  await toggleMaximised(page, file);
}

async function heatScene({ page, set }, step, text) {
  await caption(page, step, text);
  await ringClick(page, set.cues, await headerButton(page, 'Stop Profiling'), 'Stop Profiling');
  await awaitResults(page);
  await sleep(6000);
}

async function resultsScene({ page }, step, text) {
  await caption(page, step, text);
  await sleep(2500);
  await scrollDashboard(page, 700);
  await sleep(5000);
}

/** Off camera: the results scrolled back up, then `<stills>` prefixed heat map and results stills. */
const stillsStep = (story) => async (shot) => {
  await scrollDashboard(shot.page, -8000);
  await cpuStills(shot.page, shot.stills, story.file, story.stills);
};

/**
 * The CPU act as scenes, its steps numbered from `first`. `story` names the
 * `file` the heat map is shown on, each step's caption (`profile`, `heat`,
 * `results`), and the `stills` prefix of its heat-map and results stills.
 */
export function cpuLoop(story, first) {
  const { captions } = story;
  return [
    { clip: 'profile', retries: 3, act: startOnRow(first, captions.profile, 'Profile CPU', 'Profiling') },
    { clip: 'sample', speed: 4, act: ({ page }) => caption(page, first, captions.profile, '4×').then(() => sleep(SAMPLE_SECONDS * 1000)) },
    { clip: 'heat', act: (shot) => heatScene(shot, first + 1, captions.heat) },
    { clip: 'results', act: (shot) => resultsScene(shot, first + 2, captions.results) },
    ...(story.stills ? [{ offCamera: stillsStep(story) }] : []),
  ];
}
