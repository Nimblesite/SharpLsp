// Implements [WEB-DESIGN-MEDIA]. Shoots the profiler film's raw material in a real, isolated VS Code running the
// packaged SharpLsp VSIX against the Storefront demo app: stills (PNG, 3200x2000)
// and real-time screencast clips, plus the click cues the film's cursor follows.
// film.mjs runs it as this film's shoot; render.mjs turns its output into the
// website's assets.
import fs from 'node:fs';
import path from 'node:path';
import { cpuStills } from '../../kit/acts/cpu.mjs';
import { cueLog, record, still } from '../../kit/camera.mjs';
import { runCommand } from '../../kit/editor.mjs';
import { STOREFRONT, onSet } from '../../kit/set.mjs';
import {
  PARK,
  awaitResults,
  clickSharpLspIcon,
  demoRow,
  headerButton,
  openFile,
  rowButton,
  scrollDashboard,
  sleep,
  trackMemory,
  waitForDemoRow,
} from '../../kit/workbench.mjs';
import { captureFlameGraph } from './flamegraph.mjs';

const PROFILE_SECONDS = 10;
const MEMORY_SECONDS = 26;

async function cpuAct(page, cues, stills) {
  await cues.click(page, await rowButton(page, 'Profile CPU'), 'Profile CPU');
  await sleep(7000);
  await still(page, stills, 'profiler-live');
  await sleep((PROFILE_SECONDS - 7) * 1000);
  await cues.click(page, await headerButton(page, 'Stop Profiling'), 'Stop Profiling');
  await awaitResults(page);
  await sleep(3500);
}

async function memoryAct(page, cues) {
  await trackMemory(page, (locator, label) => cues.click(page, locator, label));
  await sleep(MEMORY_SECONDS * 1000);
}

/** The autopilot's consecutive snapshots already rank the leak suspects: no Compare step. */
async function memoryStills(page, stills) {
  await scrollDashboard(page, 250);
  await still(page, stills, 'profiler-memory');
  await scrollDashboard(page, 8000);
  await still(page, stills, 'profiler-leaks');
}

async function prepare(page, stills) {
  await runCommand(page, 'Notifications: Toggle Do Not Disturb Mode');
  await clickSharpLspIcon(page);
  await openFile(page, 'CheckoutPipeline.cs');
  await sleep(15_000);
  await waitForDemoRow(page);
  await page.mouse.move(PARK.x, PARK.y);
  await demoRow(page).hover();
  await sleep(600);
  await page.screenshot({ path: path.join(stills, 'profiler-processes.png') });
}

async function acts({ page, cdp, app }, out, stills) {
  const clips = path.join(out, 'clips');
  const set = { page, cdp, cues: cueLog(clips), frames: path.join(out, 'frames'), clips };
  await prepare(page, stills);
  await record(set, 'cpu', () => cpuAct(page, set.cues, stills));
  await cpuStills(page, stills, 'CheckoutPipeline.cs', 'profiler');
  await runCommand(page, 'View: Close All Editors');
  await openFile(page, 'SessionCache.cs');
  app.stop();
  await app.start();
  await waitForDemoRow(page);
  await record(set, 'memory', () => memoryAct(page, set.cues));
  await memoryStills(page, stills);
}

/** Shoot the stills, the CPU and memory clips with their click cues, and the flame graph into `out`. */
export async function shoot(out) {
  const stills = path.join(out, 'stills');
  fs.mkdirSync(stills, { recursive: true });
  fs.mkdirSync(path.join(out, 'clips'), { recursive: true });
  await onSet({ demo: STOREFRONT, out }, async (shot) => {
    await acts(shot, out, stills);
    await captureFlameGraph(path.join(shot.workspace, '.sharplsp/profiles'), out);
  });
}
