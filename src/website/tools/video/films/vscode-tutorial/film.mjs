// Implements [WEB-DESIGN-MEDIA] and [WEB-DESIGN-MEDIA-CHAPTERS]. The VS Code
// tutorial's film (`vscode-tutorial`): one shot per tutorial step ([TUTORIAL-STEPS]),
// F# first, each doing exactly what its step asks, so the tutorial panel plays
// the step's own chapter beside the editor while the reader does it live.
//
//   node src/website/tools/video/film.mjs vscode-tutorial
import { LANGUAGE, closeAll, hoverEach, navigate, peekReferences, reopen, scene, typeText } from '../../kit/acts/language.mjs';
import {
  AT_CHECKOUT,
  AT_PIPELINE,
  AT_PROGRAM_CS,
  AT_SESSIONS,
  PIPELINE,
  csharpCheapest,
  fsharpCheapest,
  missingCase,
  ready,
  repair,
  unfoldShop,
} from '../../kit/acts/shop.mjs';
import { ringClick } from '../../kit/overlay.mjs';
import { SHOP } from '../../kit/set.mjs';
import { clickSharpLspIcon, openFile, sleep } from '../../kit/workbench.mjs';

/** Quick Open (Cmd+P) with `name` typed key by key, then opened. */
const quickOpen = (name) => async ({ page }) => {
  await page.keyboard.press('Meta+P');
  await page.locator('.quick-input-widget input').waitFor();
  await sleep(600);
  await typeText(page, name, 110);
  await sleep(1400);
  await page.keyboard.press('Enter');
  await sleep(3000);
};

/** Off camera: every editor closed and the side bar folded away, so the film opens on an empty editor. */
async function bare({ page }) {
  await closeAll(page);
  await clickSharpLspIcon(page);
}

/** The SharpLsp icon clicked in the activity bar, then the solution unfolded. */
async function solutionExplorer(shot) {
  await ringClick(shot.page, shot.set.cues, shot.page.locator('.activitybar a[aria-label^="SharpLsp"]').first(), 'SharpLsp');
  await sleep(1500);
  await unfoldShop(shot);
}

/** Open `file`, then put the caret on `spot` and press `key`. */
const jump = (file, spot, key) => async ({ page }) => {
  await openFile(page, file);
  await navigate(page, spot, key);
  await sleep(3500);
};

const F12_PRODUCT = { line: 23, word: 'Product' };

export default {
  name: 'vscode-tutorial',
  demo: SHOP,
  settings: LANGUAGE,
  poster: { scene: 'fsharp-completion', at: 8 },
  scenes: [
    ...ready(AT_CHECKOUT, AT_SESSIONS, AT_PROGRAM_CS, AT_PIPELINE),
    { offCamera: bare },
    scene('fsharp-open', 1, 'F#: open a source file (Cmd+P)', quickOpen('Checkout.fs'), { chapter: 'FSharp.OpenFile' }),
    scene('fsharp-hover', 2, 'Rest the mouse on a function: its F# signature', ({ page }) =>
      hoverEach(page, [{ line: 28, word: 'parseCatalog' }, { line: 28, word: 'pickBasket' }], { scroll: 300, hold: 3200 }), { chapter: 'FSharp.Hover' }),
    scene('fsharp-completion', 3, 'Type a dot: completion lists what fits', fsharpCheapest, { chapter: 'FSharp.Completion' }),
    scene('fsharp-definition', 4, 'F12 goes to the definition', ({ page }) => navigate(page, F12_PRODUCT, 'F12').then(() => sleep(3500)), {
      retries: 3,
      chapter: 'FSharp.Definition',
    }),
    scene('fsharp-references', 5, 'Shift+F12 finds every reference', ({ page }) => peekReferences(page, { line: 3, word: 'Product' }, 5500), {
      chapter: 'FSharp.References',
    }),
    scene('fsharp-action', 6, 'Cmd+. on a warning: pick the fix', missingCase, { chapter: 'FSharp.CodeAction' }),
    scene('solution', 7, 'The SharpLsp icon opens the Solution Explorer', solutionExplorer, { chapter: 'SolutionExplorer' }),
    { offCamera: ({ page }) => closeAll(page) },
    scene('csharp-open', 8, 'C#: open a source file (Cmd+P)', quickOpen('Program.cs'), { chapter: 'CSharp.OpenFile' }),
    scene('csharp-hover', 9, 'Rest the mouse on a symbol: its docs and type', ({ page }) =>
      hoverEach(page, [{ line: 5, word: 'Generate' }, { line: 10, word: 'var' }], { hold: 3200 }), { chapter: 'CSharp.Hover' }),
    // Each take starts from the file as saved, so a retried take never types twice.
    scene('csharp-completion', 10, 'Type a dot: completion lists what fits', async (shot) => {
      await reopen(PIPELINE)(shot);
      await csharpCheapest(shot);
    }, { retries: 3, chapter: 'CSharp.Completion' }),
    { offCamera: ({ page }) => closeAll(page) },
    scene('csharp-definition', 11, 'F12 goes to the definition', jump('Program.cs', { line: 10, word: 'Checkout' }, 'F12'), {
      retries: 3,
      chapter: 'CSharp.Definition',
    }),
    scene('csharp-references', 12, 'Shift+F12 finds every reference', ({ page }) => peekReferences(page, { line: 16, word: 'Product' }, 5500), {
      chapter: 'CSharp.References',
    }),
    scene('csharp-action', 13, 'Cmd+. on an error: generate the missing method',
      repair(12, 'var receipt = Receipt(invoice);', 'Receipt', 'Generate method'), { chapter: 'CSharp.CodeAction' }),
  ],
};
