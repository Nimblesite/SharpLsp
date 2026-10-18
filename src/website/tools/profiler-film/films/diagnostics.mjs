// Implements [WEB-DESIGN-MEDIA]. The "Diagnostics" walkthrough
// (`diagnostics`): errors and SharpLsp's analyzer findings on unsaved F# and
// C# edits, each read by hovering it, then the Problems panel that lists them.
//
//   node src/website/tools/profiler-film/film.mjs diagnostics
import { LANGUAGE, hoverEach, scene } from '../kit/acts/language.mjs';
import { AT_CHECKOUT, AT_PIPELINE, ready } from '../kit/acts/shop.mjs';
import { SHOP } from '../kit/set.mjs';
import { openFile, sleep, typeAt } from '../kit/workbench.mjs';

/** Type `edits` into `file` (each a `typeAt` edit), let the engine catch up, and hover each of `spots`. */
const flag = (file, edits, spots) => async ({ page }) => {
  await openFile(page, file);
  for (const edit of edits) await typeAt(page, edit);
  await page.keyboard.press('Escape');
  await sleep(3500);
  await hoverEach(page, spots, { hold: 3600 });
};

export default {
  name: 'diagnostics',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'diagnostics.narration.json',
  poster: { scene: 'problems', at: 3 },
  scenes: [
    ...ready(AT_PIPELINE, AT_CHECKOUT),
    scene(
      'fsharp',
      1,
      'F#: compiler errors and SharpLsp analyzers, as you type',
      flag(
        'Checkout.fs',
        [
          { line: 4, append: true, text: '\nopen System.Text' },
          { line: 22, append: true, text: '\n\nlet count: int = "12"' },
        ],
        [{ line: 5, word: 'System' }, { line: 24, word: '12' }],
      ),
    ),
    scene(
      'csharp',
      2,
      'C#: Roslyn flags the mistake before you save',
      flag('CheckoutPipeline.cs', [{ line: 12, append: true, text: '\n        int items = "twelve";' }], [{ line: 13, word: 'twelve' }]),
    ),
    scene(
      'deadcode',
      3,
      'Dead code: a private method nothing calls',
      flag('CheckoutPipeline.cs', [{ line: 15, append: true, text: '\n\n    private static decimal Unused() => 0m;' }], [{ line: 17, word: 'Unused' }]),
    ),
    scene('problems', 4, 'Errors and warnings in the Problems panel', async ({ page }) => {
      await page.keyboard.press('Meta+Shift+M');
      await sleep(5500);
    }),
  ],
};
