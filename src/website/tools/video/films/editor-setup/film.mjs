// Implements [WEB-DESIGN-MEDIA]. The "Editor Setup" walkthrough
// (`editor-setup`): the extension restarting its server from the status bar,
// everything it adds under SharpLsp in the Command Palette, and the
// trusted-workspace settings for development builds.
//
//   node src/website/tools/video/film.mjs editor-setup
import { runCommand } from '../../kit/editor.mjs';
import { LANGUAGE, awaitSemantics, prepareCode, scene, settingsEditor, typeText } from '../../kit/acts/language.mjs';
import { centre, pointAt } from '../../kit/overlay.mjs';
import { SHOP } from '../../kit/set.mjs';
import { sleep } from '../../kit/workbench.mjs';

const PROBE = { line: 10, word: 'Checkout' };

async function activation({ page }) {
  const status = await page.locator('.statusbar-item', { hasText: 'SharpLsp' }).first().boundingBox();
  if (status) await pointAt(page, centre(status));
  await runCommand(page, 'SharpLsp: Restart Language Server');
  await awaitSemantics(page, PROBE);
  await sleep(1500);
}

async function palette({ page }) {
  await page.locator('.command-center .command-center-center').click();
  await page.locator('.quick-input-widget input').waitFor();
  await typeText(page, '>SharpLsp', 90);
  await sleep(3000);
  for (let row = 0; row < 8; row++) {
    await page.keyboard.press('ArrowDown');
    await sleep(350);
  }
  await sleep(1500);
  await page.keyboard.press('Escape');
}

async function trust({ page }) {
  await settingsEditor.open(page, 'sharplsp path');
  await sleep(5000);
}

export default {
  name: 'editor-setup',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'narration.json',
  poster: { scene: 'palette', at: 6 },
  scenes: [
    { offCamera: prepareCode('Program.cs', PROBE) },
    scene('activation', 1, 'The VSIX brings the server and both sidecars: no other install', activation, { speed: 2 }),
    scene('palette', 2, 'Everything it adds, under SharpLsp in the Command Palette', palette),
    scene('trust', 3, 'Development builds: path settings, for trusted workspaces only', trust),
  ],
};
