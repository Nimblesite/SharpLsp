// Implements [WEB-DESIGN-MEDIA]. Moves on the Shop demo (demos/Shop.slnx) that
// several language films tell: code typed through completion in F# and C#, a
// match completed by a quick fix, and a rename that reaches another file.
import { hoverOn } from '../code.mjs';
import { openFile, sleep, typeAt } from '../workbench.mjs';
import { complete, prepareCode, quickFix, renameTo, scrollEditor, typeText, warm } from './language.mjs';

/** Type `opening` after `line`, then for each `[filter, then]`: accept the completion `filter` narrows to, and type `then`. */
async function typeThroughCompletion(page, line, opening, steps) {
  await typeAt(page, { line, append: true, text: opening });
  for (const [filter, then] of steps) {
    await complete(page, filter);
    await typeText(page, then);
  }
  await page.keyboard.press('Escape');
  await sleep(1500);
}

/** Checkout.fs: a new function typed through List's functions, then the record's fields. */
export async function fsharpCheapest({ page }) {
  await scrollEditor(page, 260);
  await typeThroughCompletion(page, 21, '\n\nlet cheapest (basket: Product list) =\n    basket |> List.', [
    ['minB', ' (fun p -> p.'],
    ['Pri', ')'],
  ]);
}

/** CheckoutPipeline.cs: the same function in C#, through LINQ's members, then the record's. */
export const csharpCheapest = ({ page }) =>
  typeThroughCompletion(page, 14, '\n\n    public static Product Cheapest(List<Product> basket) =>\n        basket.', [
    ['MinB', '(p => p.'],
    ['Pri', ')!;'],
  ]);

/** The Shop demo's files, each with a word whose hover proves its engine has loaded it. */
export const AT_PIPELINE = ['CheckoutPipeline.cs', { line: 10, word: 'PickBasket' }];
export const AT_PROGRAM_CS = ['Program.cs', { line: 10, word: 'Checkout' }];
export const AT_CHECKOUT = ['Checkout.fs', { line: 28, word: 'parseCatalog' }];
export const AT_PROGRAM_FS = ['Program.fs', { line: 9, word: 'generate' }];
export const AT_SESSIONS = ['Sessions.fs', { line: 9, word: 'CheckedOut' }];

/** Off camera: the editor prepared on the first `[file, probe]`, then each other one warmed. */
export const ready = ([file, probe], ...others) => [{ offCamera: prepareCode(file, probe) }, ...others.map(([other, at]) => ({ offCamera: warm(other, at) }))];

/** Sessions.fs: a match that misses a union case, completed by the quick fix. */
export async function missingCase({ page, set }) {
  await openFile(page, 'Sessions.fs');
  await typeAt(page, { line: 10, append: true, text: '\n\nlet describe stage =\n    match stage with\n    | Browsing -> "still browsing"' });
  await page.keyboard.press('Escape');
  await sleep(1500);
  await quickFix(page, set.cues, { line: 13, word: 'match' }, 'Generate');
  await sleep(2000);
}

/** Sessions.fs: `remember` renamed, then Program.fs, which calls it, shown by the new name. */
export async function renameAcrossFiles({ page }) {
  await openFile(page, 'Sessions.fs');
  await renameTo(page, { line: 8, word: 'remember' }, 'rememberOrder');
  await openFile(page, 'Program.fs');
  await hoverOn(page, { line: 11, word: 'rememberOrder' });
  await sleep(3000);
}
