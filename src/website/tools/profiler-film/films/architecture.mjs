// Implements [WEB-DESIGN-MEDIA]. The "Architecture" walkthrough
// (`architecture`): the host's own log, filtered to hover requests, routing an
// F# hover to the F# Compiler Service and a C# hover to Roslyn; then folding,
// answered by tree-sitter in the host with no engine involved.
//
//   node src/website/tools/profiler-film/film.mjs architecture
import { runCommand } from '../kit/editor.mjs';
import { LANGUAGE, hoverEach, scene, typeText } from '../kit/acts/language.mjs';
import { AT_CHECKOUT, AT_PIPELINE, ready } from '../kit/acts/shop.mjs';
import { SHOP } from '../kit/set.mjs';
import { openFile, sleep } from '../kit/workbench.mjs';

const PIPELINE = 'CheckoutPipeline.cs';

/** The SharpLsp log in the panel, showing only lines that mention `text`. */
async function logFiltered(page, text) {
  await runCommand(page, 'SharpLsp: Show Output Channel');
  const filter = page.locator('.part.panel input[placeholder^="Filter"]').first();
  await filter.click();
  await page.keyboard.press('Meta+A');
  await typeText(page, text, 60);
  await sleep(1200);
}

async function routing({ page }) {
  await logFiltered(page, 'method=textDocument/hover');
  await openFile(page, 'Checkout.fs');
  // Words the warm-up never hovered: the host answers a repeat from its cache, without a sidecar.
  await hoverEach(page, [{ line: 28, word: 'pickBasket' }], { scroll: 300, hold: 3500 });
  await openFile(page, PIPELINE);
  await hoverEach(page, [{ line: 11, word: 'PriceBasket' }], { hold: 4000 });
}

async function folding({ page }) {
  await page.keyboard.press('Escape');
  for (const chord of [['Meta+K', 'Meta+0'], ['Meta+K', 'Meta+J']]) {
    for (const key of chord) await page.keyboard.press(key);
    await sleep(3500);
  }
}

export default {
  name: 'architecture',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'architecture.narration.json',
  poster: { scene: 'routing', at: 10 },
  scenes: [
    ...ready(AT_PIPELINE, AT_CHECKOUT),
    scene('routing', 1, 'One host, two engines: each request goes to its language\'s sidecar', routing),
    scene('folding', 2, 'Syntax features stay in the host: tree-sitter folds the file', folding),
  ],
};
