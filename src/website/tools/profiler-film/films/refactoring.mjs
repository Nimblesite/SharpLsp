// Implements [WEB-DESIGN-MEDIA]. The "Refactoring & Code Actions" walkthrough
// (`refactoring`): an F# match completed and a function renamed across files,
// then C# fixes that generate a missing method and add a missing using.
//
//   node src/website/tools/profiler-film/film.mjs refactoring
import { LANGUAGE, quickFix, scene } from '../kit/acts/language.mjs';
import { AT_PIPELINE, AT_SESSIONS, missingCase, ready, renameAcrossFiles } from '../kit/acts/shop.mjs';
import { SHOP } from '../kit/set.mjs';
import { openFile, sleep, typeAt } from '../kit/workbench.mjs';

const PIPELINE = 'CheckoutPipeline.cs';

/** Type a line after `line` that breaks the build, then apply the fix titled `title` at `word`. */
const repair = (line, text, word, title) => async ({ page, set }) => {
  await openFile(page, PIPELINE);
  await typeAt(page, { line, append: true, text: `\n        ${text}` });
  await page.keyboard.press('Escape');
  await sleep(2000);
  await quickFix(page, set.cues, { line: line + 1, word }, title);
  await sleep(2500);
};

export default {
  name: 'refactoring',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'refactoring.narration.json',
  poster: { scene: 'generate', at: 7 },
  scenes: [
    ...ready(AT_PIPELINE, AT_SESSIONS),
    scene('fsharp', 1, 'Cmd+. on an F# match: generate the missing union case', missingCase, { speed: 2 }),
    scene('rename', 2, 'Rename (F2) reaches every file in the project', renameAcrossFiles),
    scene('generate', 3, 'C#: call a method that doesn\'t exist, and generate it', repair(12, 'var receipt = Receipt(invoice);', 'Receipt', 'Generate method')),
    scene('using', 4, 'Use a type, and add its missing using', repair(13, 'var builder = new StringBuilder();', 'StringBuilder', 'using System.Text')),
  ],
};
