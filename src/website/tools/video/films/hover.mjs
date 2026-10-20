// Implements [WEB-DESIGN-MEDIA]. The "Hover and Quick Info" walkthrough
// (`hover`): F# signatures and doc comments, union cases and .NET types, C#
// XML docs and the type behind `var`, and a hover that reads unsaved edits.
//
//   node src/website/tools/video/film.mjs hover
import { hoverOn } from '../kit/code.mjs';
import { LANGUAGE, hoverEach, scene } from '../kit/acts/language.mjs';
import { AT_PROGRAM_CS, AT_PROGRAM_FS, ready } from '../kit/acts/shop.mjs';
import { SHOP } from '../kit/set.mjs';
import { openFile, sleep, typeAt } from '../kit/workbench.mjs';

/** Catalog.fs: the doc comment rewritten and left unsaved; the next hover shows the new words. */
async function unsaved({ page }) {
  await openFile(page, 'Catalog.fs');
  await typeAt(page, { line: 13, text: '/// The catalog as CSV: one product per line, made up from its index.' });
  await page.keyboard.press('Escape');
  await sleep(800);
  await hoverOn(page, { line: 14, word: 'generate' });
  await sleep(4000);
}

const visit = (file, spots) => async ({ page }) => {
  await openFile(page, file);
  await hoverEach(page, spots, { hold: 3200 });
};

export default {
  name: 'hover',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'hover.narration.json',
  poster: { scene: 'csharp', at: 4 },
  scenes: [
    ...ready(AT_PROGRAM_CS, AT_PROGRAM_FS),
    scene('fsharp', 1, 'F#: the inferred signature, with your doc comment', visit('Program.fs', [{ line: 9, word: 'generate' }, { line: 11, word: 'checkout' }])),
    scene('union', 2, 'Union cases and .NET types, typed as F# sees them', visit('Sessions.fs', [{ line: 9, word: 'CheckedOut' }, { line: 6, word: 'Dictionary' }])),
    scene('csharp', 3, 'C#: XML docs rendered, and the type behind var', visit('Program.cs', [{ line: 5, word: 'Generate' }, { line: 10, word: 'var' }])),
    scene('live', 4, 'Hover reads your unsaved edits', unsaved),
  ],
};
