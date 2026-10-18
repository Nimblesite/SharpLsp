// Implements [WEB-DESIGN-MEDIA]. The F# language walkthrough the "F# Language
// Support" page plays (`fsharp-language`): hover, completion, definition and
// references, a generated match case, a rename across files, and F#
// Interactive, all on FsStorefront in the Shop solution.
//
//   node src/website/tools/profiler-film/film.mjs fsharp-language
import { runCommand } from '../kit/editor.mjs';
import { LANGUAGE, hoverEach, navigate, peekReferences, scene, typeText } from '../kit/acts/language.mjs';
import { AT_CHECKOUT, fsharpCheapest, missingCase, ready, renameAcrossFiles } from '../kit/acts/shop.mjs';
import { SHOP } from '../kit/set.mjs';
import { goTo, openFile, sleep } from '../kit/workbench.mjs';

/** The catalog's code sent to F# Interactive, then called there. */
async function interactive({ page }) {
  await openFile(page, 'Catalog.fs');
  await goTo(page, 3, 1);
  for (let line = 3; line < 14; line++) await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+End');
  await runCommand(page, 'SharpLsp: F# Interactive: Send Selection');
  await page.locator('.terminal-wrapper').first().waitFor();
  await sleep(4000);
  await page.locator('.terminal-wrapper').first().click();
  await typeText(page, 'generate 3;;', 90);
  await page.keyboard.press('Enter');
  await sleep(4000);
}

export default {
  name: 'fsharp-language',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'fsharp-language.narration.json',
  poster: { scene: 'complete', at: 9 },
  scenes: [
    ...ready(AT_CHECKOUT),
    scene('hover', 1, 'Hover any F# symbol: its signature, from the F# compiler', ({ page }) =>
      hoverEach(page, [{ line: 28, word: 'parseCatalog' }, { line: 28, word: 'pickBasket' }, { line: 29, word: 'priceBasket' }], { scroll: 300 }),
    ),
    scene('complete', 2, 'Completion knows your types: List functions, then record fields', fsharpCheapest),
    scene('define', 3, 'Go to Definition (F12) crosses files', (shot) => navigate(shot.page, { line: 23, word: 'Product' }, 'F12')),
    scene('references', 4, 'Find All References (Shift+F12), project-wide', ({ page }) => peekReferences(page, { line: 3, word: 'Product' })),
    scene('fix', 5, 'Quick fixes write code: generate the missing union case', missingCase, { speed: 2 }),
    scene('rename', 6, 'Rename (F2), and every file that calls it follows', renameAcrossFiles),
    scene('interactive', 7, 'Send code to F# Interactive and run it on the spot', interactive),
  ],
};
