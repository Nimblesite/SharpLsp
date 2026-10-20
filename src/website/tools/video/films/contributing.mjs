// Implements [WEB-DESIGN-MEDIA]. The "Contributing" walkthrough
// (`contributing`): the repository's layout, its specs and their IDs, and a
// test suite (the Rust host's unit tests) built and run from a terminal, on a
// clean copy of the committed tree.
//
//   node src/website/tools/video/film.mjs contributing
import { spawnSync } from 'node:child_process';
import { runCommand } from '../kit/editor.mjs';
import { scene, typeText } from '../kit/acts/language.mjs';
import { REPO } from '../kit/set.mjs';
import { openFile, sleep } from '../kit/workbench.mjs';

const SUITE = 'cargo test -p sharplsp --bins';

/** A plain bash with a bare prompt: no profile, so no name or host reaches the frame. */
const SETTINGS = {
  'terminal.integrated.profiles.osx': {
    film: { path: '/bin/bash', args: ['--noprofile', '--norc'], env: { PS1: '$ ', BASH_SILENCE_DEPRECATION_WARNING: '1' } },
  },
  'terminal.integrated.defaultProfile.osx': 'film',
  'terminal.integrated.fontSize': 14,
};

/** Open the Explorer's folders named in `path`, one level at a time. */
async function unfoldPath(page, path) {
  for (const folder of path) {
    await page.locator('.explorer-viewlet').getByRole('treeitem', { name: folder, exact: true }).first().click();
    await sleep(900);
  }
}

async function layout({ page }) {
  await unfoldPath(page, ['src']);
  await sleep(1500);
  await unfoldPath(page, ['editors']);
  await sleep(3500);
}

async function specs({ page }) {
  await unfoldPath(page, ['src', 'docs', 'specs']);
  await openFile(page, 'SHARPLSP-SPEC.md');
  await sleep(2500);
  await page.mouse.move(1000, 500);
  await page.mouse.wheel(0, 1200);
  await sleep(3500);
}

const running = () => spawnSync('pgrep', ['-f', SUITE]).status === 0;

async function suite({ page }) {
  await runCommand(page, 'Terminal: Create New Terminal');
  await page.locator('.terminal-wrapper').first().waitFor();
  await sleep(1500);
  await typeText(page, SUITE, 50);
  await page.keyboard.press('Enter');
  await sleep(5000);
  for (const deadline = Date.now() + 600_000; running() && Date.now() < deadline; ) await sleep(2000);
  // A few empty prompts lift the result line clear of the caption.
  for (let prompt = 0; prompt < 4; prompt++) await page.keyboard.press('Enter');
  await sleep(6000);
}

export default {
  name: 'contributing',
  demo: REPO,
  settings: SETTINGS,
  narration: 'contributing.narration.json',
  poster: { scene: 'layout', at: 5 },
  scenes: [
    {
      offCamera: async ({ page }) => {
        await runCommand(page, 'Notifications: Toggle Do Not Disturb Mode');
        await runCommand(page, 'View: Show Explorer');
      },
    },
    scene('layout', 1, 'One repository: the Rust host, the .NET sidecars, the editors', layout),
    scene('specs', 2, 'Specs are the source of truth: every section has an ID', specs),
    scene('suite', 3, 'Build and test from the command line', suite, { speed: 8 }),
  ],
};
