// Implements [WEB-DESIGN-MEDIA]. The "Go to Definition" walkthrough
// (`navigation`): definitions in F# and C#, references in a peek window, and
// a framework type opened as decompiled source.
//
//   node src/website/tools/profiler-film/film.mjs navigation
import { LANGUAGE, navigate, peekReferences, scene } from '../kit/acts/language.mjs';
import { AT_PROGRAM_CS, AT_SESSIONS, ready } from '../kit/acts/shop.mjs';
import { SHOP } from '../kit/set.mjs';
import { openFile, sleep } from '../kit/workbench.mjs';

/** Open `file`, press `key` on `spot`, and hold on where it lands. */
const jump = (file, spot, key = 'F12') => async ({ page }) => {
  await openFile(page, file);
  await navigate(page, spot, key);
  await sleep(3000);
};

export default {
  name: 'navigation',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'navigation.narration.json',
  poster: { scene: 'references', at: 4 },
  scenes: [
    ...ready(AT_PROGRAM_CS, AT_SESSIONS),
    scene('fsharp', 1, 'F12 jumps to a definition, in F#…', jump('Sessions.fs', { line: 9, word: 'CheckedOut' }), { retries: 3 }),
    scene('csharp', 2, '…and in C#', jump('Program.cs', { line: 10, word: 'Checkout' }), { retries: 3 }),
    scene('references', 3, 'Shift+F12: every reference, in a peek window', ({ page }) => peekReferences(page, { line: 16, word: 'Product' }, 6000)),
    scene('metadata', 4, 'Framework types open as decompiled source', async ({ page }) => {
      await navigate(page, { line: 17, word: 'JsonSerializer' }, 'F12');
      await sleep(4500);
    }),
  ],
};
