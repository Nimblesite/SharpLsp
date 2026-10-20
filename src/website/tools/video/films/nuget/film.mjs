// Implements [WEB-DESIGN-MEDIA]. The "NuGet Package Manager" walkthrough
// (`nuget`): the browser opened on the F# project, a package found on
// nuget.org, installed and restored, and its reference in the project file.
//
//   node src/website/tools/video/film.mjs nuget
import { LANGUAGE, scene, typeText } from '../../kit/acts/language.mjs';
import { openMenu, pickMenu } from '../../kit/acts/explorer.mjs';
import { ringClick } from '../../kit/overlay.mjs';
import { AT_PROGRAM_FS, ready } from '../../kit/acts/shop.mjs';
import { SHOP } from '../../kit/set.mjs';
import { panel, sleep } from '../../kit/workbench.mjs';

const PROJECT = /^FsStorefront \(FsStorefront\.fsproj\)/;
const PACKAGE = 'FsToolkit.ErrorHandling';

async function browse({ page, set }) {
  await openMenu(page, PROJECT);
  await pickMenu(page, set.cues, 'Browse NuGet Packages');
  await panel(page).locator('.package-item').first().waitFor({ timeout: 60_000 });
  await sleep(3500);
}

async function search({ page, set }) {
  const browser = panel(page);
  await ringClick(page, set.cues, browser.locator('#searchInput'), 'Search');
  await typeText(page, PACKAGE, 70);
  const hit = browser.locator('.package-item', { hasText: PACKAGE }).first();
  await hit.waitFor({ timeout: 60_000 });
  await sleep(1500);
  await ringClick(page, set.cues, hit, PACKAGE);
  await sleep(4500);
}

async function install({ page, set }) {
  const browser = panel(page);
  await ringClick(page, set.cues, browser.locator('.btn-primary', { hasText: 'Install' }), 'Install');
  await browser.locator('.btn-danger', { hasText: 'Remove' }).waitFor({ timeout: 180_000 });
  await sleep(3000);
}

async function installed({ page, set }) {
  await ringClick(page, set.cues, panel(page).getByText('Installed', { exact: true }).first(), 'Installed');
  await sleep(3500);
  await openMenu(page, PROJECT);
  await pickMenu(page, set.cues, 'Open Project File');
  await sleep(4500);
}

export default {
  name: 'nuget',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'narration.json',
  poster: { scene: 'search', at: 9 },
  scenes: [
    ...ready(AT_PROGRAM_FS),
    scene('open', 1, 'Right-click a project: Browse NuGet Packages', browse),
    scene('search', 2, 'Search nuget.org, then pick a package', search),
    scene('install', 3, 'Install: the project file is edited, then restored', install, { speed: 2 }),
    scene('installed', 4, 'Installed, and referenced in the project file', installed),
  ],
};
