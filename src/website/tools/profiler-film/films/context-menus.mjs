// Implements [WEB-DESIGN-MEDIA]. The "Context Menus" walkthrough
// (`context-menus`): the Solution Explorer's menus on the solution, a
// project (Build, Open Project File) and a C# type (Sort Members).
//
//   node src/website/tools/profiler-film/film.mjs context-menus
import { LANGUAGE, scene } from '../kit/acts/language.mjs';
import { openMenu, pickMenu, unfold } from '../kit/acts/explorer.mjs';
import { AT_PROGRAM_CS, ready } from '../kit/acts/shop.mjs';
import { SHOP } from '../kit/set.mjs';
import { openFile, sleep } from '../kit/workbench.mjs';

const PROJECT = /^Storefront \(Storefront\.csproj\)/;

/** Right-click `name`'s row, choose `item`, and hold for `hold` ms on what it does. */
const choose = (name, item, hold) => async ({ page, set }) => {
  await openMenu(page, name);
  await pickMenu(page, set.cues, item);
  await sleep(hold);
};

export default {
  name: 'context-menus',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'context-menus.narration.json',
  poster: { scene: 'solution', at: 3 },
  scenes: [
    ...ready(AT_PROGRAM_CS),
    scene('solution', 1, 'Every node in the Solution Explorer has its own menu', async ({ page }) => {
      await openMenu(page, /^Shop\.slnx/);
      await sleep(3500);
      await page.keyboard.press('Escape');
    }),
    scene('build', 2, 'Build, Rebuild or Clean a project', choose(PROJECT, 'Build', 14_000), { speed: 2 }),
    scene('project', 3, 'Open Project File', choose(PROJECT, 'Open Project File', 3500)),
    scene('sort', 4, 'Sort Members on a C# type', async (shot) => {
      await unfold(shot.page, PROJECT);
      await unfold(shot.page, /^Storefront$/);
      await choose(/^CheckoutPipeline$/, 'Sort Members', 1500)(shot);
      await openFile(shot.page, 'CheckoutPipeline.cs');
      await sleep(5000);
    }),
  ],
};
