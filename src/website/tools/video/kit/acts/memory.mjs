// Implements [WEB-DESIGN-MEDIA]. The memory act as scenes: track the demo,
// watch the heap grow, open a suspect, ask what keeps it alive, type the fix,
// rebuild, and track the fixed build again. A film tells it in its own words
// (`story`), on its own demo and file.
import { runCommand } from '../editor.mjs';
import { caption, ringClick } from '../overlay.mjs';
import { startOnRow } from '../scenes.mjs';
import { buildDemo } from '../set.mjs';
import {
  awaitDashboard,
  clickSharpLspIcon,
  headerButton,
  openFile,
  panel,
  scrollDashboard,
  sleep,
  toggleMaximised,
  typeAt,
  waitForDemoRow,
} from '../workbench.mjs';

const GROW_SECONDS = 6;
const VERIFY_SECONDS = 45;
const GRAPH = 'Retention Graph';

/** The status-bar progress of an auto-capture still talking to the target. */
const capturing = (page) => page.locator('.statusbar', { hasText: 'Auto-capturing memory' });

const tracking = (step, text) => startOnRow(step, text, 'Track Memory', 'Memory: tracking');

/** Pick `type` from the types the latest snapshot reported; a take without it is shot again. */
async function pickType(page, type) {
  await page.locator('.quick-input-widget input').fill(type.split('.').at(-1));
  await sleep(700);
  if ((await page.locator('.quick-input-list .monaco-list-row', { hasText: type }).count()) === 0) {
    await page.keyboard.press('Escape');
    throw new Error(`${type} is not in the latest snapshot yet`);
  }
  await page.keyboard.press('Enter');
}

/**
 * Off camera: restore the maximised graph, stop tracking, let any in-flight
 * capture finish before the leaking app exits, and reopen a clean `file`.
 */
async function stopAndReopen({ page, app }, file) {
  await toggleMaximised(page, GRAPH);
  await clickSharpLspIcon(page);
  await (await headerButton(page, 'Stop Memory Tracking')).click();
  await capturing(page).waitFor({ state: 'detached', timeout: 60_000 });
  app.stop();
  await openFile(page, file);
  await runCommand(page, 'File: Revert File');
  await runCommand(page, 'View: Close All Editors');
  await openFile(page, file);
  await clickSharpLspIcon(page);
  await page.locator('.monaco-editor .view-lines').first().click();
}

/** Off camera: build the fixed code and start it with the Processes view open. */
async function relaunch({ page, app, workspace }) {
  buildDemo(workspace);
  await app.start();
  await clickSharpLspIcon(page);
  await waitForDemoRow(page);
}

/** Runs until the autopilot ranks a suspect High (three growths in a row), and long enough to watch the climb. */
async function growScene(page, step, text) {
  await caption(page, step, text, '8×');
  await awaitDashboard(page);
  const high = panel(page).locator('.leak-row .badge', { hasText: /high/i }).first();
  await Promise.all([high.waitFor({ state: 'attached', timeout: 120_000 }), sleep(GROW_SECONDS * 1000)]);
}

async function suspectScene({ page, set }, step, story) {
  await caption(page, step, story.captions.suspect);
  await scrollDashboard(page, 8000);
  await sleep(2500);
  await ringClick(page, set.cues, panel(page).locator('.leak-row', { hasText: story.file }).first(), 'Suspect');
  await sleep(3500);
}

async function askScene(page, step, text, type) {
  await caption(page, step, text);
  await capturing(page).waitFor({ state: 'detached', timeout: 60_000 });
  await sleep(600);
  await runCommand(page, 'SharpLsp: Show Reference Graph');
  await pickType(page, type);
}

/** The walk over a live heap of a hundred megabytes takes a while: fast-forwarded. */
async function walkScene(page, step, text) {
  await caption(page, step, text, '8×');
  await page.locator('.tab', { hasText: GRAPH }).waitFor({ timeout: 240_000 });
  await sleep(1000);
}

/** The graph maximised, so its root and its rows read at a glance; `atGraph` runs once it is. */
async function graphScene(shot, step, text, atGraph) {
  await caption(shot.page, step, text);
  await toggleMaximised(shot.page, GRAPH);
  if (atGraph) await atGraph(shot);
  await sleep(7000);
}

async function fixScene(page, step, story) {
  await caption(page, step, story.captions.fix);
  await sleep(2000);
  for (const edit of story.fix) await typeAt(page, edit);
  await page.keyboard.press('Meta+S');
  await sleep(3000);
}

async function verifyScene(page, step, text) {
  await caption(page, step, text, '8×');
  await awaitDashboard(page);
  await sleep(VERIFY_SECONDS * 1000);
}

async function steadyScene(page, step, text) {
  await caption(page, step, text);
  await sleep(2500);
  await scrollDashboard(page, 8000);
  await sleep(4000);
}

/**
 * The memory act as scenes, its steps numbered from `first`. `story` names the
 * `file` the fix goes in, the suspect's `type`, the `fix`'s edits (see typeAt)
 * and each step's caption (`rooted`, over the drawn graph, defaults to the
 * `graph` question), plus an off-camera `afterSuspect` step and an `atGraph`
 * step that sees the graph maximised.
 */
export function memoryLoop(story, first) {
  const step = (offset) => first + offset;
  const { captions } = story;
  return [
    { clip: 'track', retries: 3, act: tracking(step(0), captions.track) },
    { clip: 'grow', speed: 8, act: ({ page }) => growScene(page, step(1), captions.grow) },
    { clip: 'suspect', act: (shot) => suspectScene(shot, step(2), story) },
    ...(story.afterSuspect ? [{ offCamera: story.afterSuspect }] : []),
    { clip: 'ask', retries: 5, act: ({ page }) => askScene(page, step(3), captions.graph, story.type) },
    { clip: 'walk', speed: 8, act: ({ page }) => walkScene(page, step(3), captions.graph) },
    { clip: 'graph', act: (shot) => graphScene(shot, step(3), captions.rooted ?? captions.graph, story.atGraph) },
    { offCamera: (shot) => stopAndReopen(shot, story.file) },
    { clip: 'fix', act: ({ page }) => fixScene(page, step(4), story) },
    { offCamera: relaunch },
    { clip: 'retrack', retries: 3, act: tracking(step(5), captions.retrack) },
    { clip: 'verify', speed: 8, act: ({ page }) => verifyScene(page, step(5), captions.retrack) },
    { clip: 'steady', act: ({ page }) => steadyScene(page, step(6), captions.steady) },
  ];
}
