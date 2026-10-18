// Implements [WEB-DESIGN-MEDIA]. The "Code Completions" walkthrough
// (`code-completions`): F# and C# member completion typed live, then a type
// from a namespace the file never imported, with its using added.
//
//   node src/website/tools/profiler-film/film.mjs completions
import { clickOn } from '../kit/code.mjs';
import { LANGUAGE, complete, scene, typeText } from '../kit/acts/language.mjs';
import { AT_CHECKOUT, AT_PIPELINE, csharpCheapest, fsharpCheapest, ready } from '../kit/acts/shop.mjs';
import { SHOP } from '../kit/set.mjs';
import { openFile, sleep, typeAt } from '../kit/workbench.mjs';

const PIPELINE = 'CheckoutPipeline.cs';

/** Completion invoked by hand on a type the file has no using for; accepting it adds one. */
async function importing({ page }) {
  await typeAt(page, { line: 17, append: true, text: '\n\n    private static string Receipt() => new StringBuil' });
  await page.keyboard.press('Control+Space');
  await complete(page, '');
  await typeText(page, '().ToString();');
  await page.keyboard.press('Escape');
  await sleep(1200);
  await clickOn(page, { line: 1, word: 'Text' });
  await sleep(3500);
}

export default {
  name: 'code-completions',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'completions.narration.json',
  poster: { scene: 'csharp', at: 6 },
  scenes: [
    ...ready(AT_PIPELINE, AT_CHECKOUT),
    scene('fsharp', 1, 'F#: list functions after a dot, then the record\'s fields', fsharpCheapest),
    scene('csharp', 2, 'C#: Roslyn completion, member by member', async (shot) => {
      await openFile(shot.page, PIPELINE);
      await csharpCheapest(shot);
    }),
    scene('import', 3, 'Ctrl+Space finds types you never imported, and adds the using', importing),
  ],
};
