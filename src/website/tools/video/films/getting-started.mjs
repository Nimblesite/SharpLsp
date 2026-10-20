// Implements [WEB-DESIGN-MEDIA]. The "Getting Started" walkthrough
// (`getting-started`): the Shop solution loaded in the Solution Explorer, C#
// and F# side by side, an F# hover, a C# completion, and the tools that ship
// with the extension.
//
//   node src/website/tools/video/film.mjs getting-started
import { LANGUAGE, hoverEach, scene, setPane } from '../kit/acts/language.mjs';
import { unfold } from '../kit/acts/explorer.mjs';
import { AT_CHECKOUT, AT_PIPELINE, csharpCheapest, ready } from '../kit/acts/shop.mjs';
import { SHOP } from '../kit/set.mjs';
import { openFile, sleep } from '../kit/workbench.mjs';

async function solution({ page }) {
  await unfold(page, /^FsStorefront \(FsStorefront\.fsproj\)/);
  await sleep(1500);
  await unfold(page, /^Storefront \(Storefront\.csproj\)/);
  await unfold(page, /^Storefront$/);
  await sleep(3000);
}

async function fsharp({ page }) {
  await openFile(page, 'Checkout.fs');
  await hoverEach(page, [{ line: 28, word: 'parseCatalog' }, { line: 28, word: 'pickBasket' }], { scroll: 300, hold: 3000 });
}

async function csharp(shot) {
  await openFile(shot.page, 'CheckoutPipeline.cs');
  await csharpCheapest(shot);
}

async function tools({ page }) {
  await setPane(page, 'Processes', true);
  await sleep(5000);
}

export default {
  name: 'getting-started',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'getting-started.narration.json',
  poster: { scene: 'solution', at: 4 },
  scenes: [
    ...ready(AT_PIPELINE, AT_CHECKOUT),
    scene('solution', 1, 'Open a folder with a solution: C# and F# load together', solution),
    scene('fsharp', 2, 'F#: the F# compiler behind every answer', fsharp),
    scene('csharp', 3, 'C#: Roslyn behind every answer', csharp),
    scene('tools', 4, 'Plus the tools: a profiler, NuGet, tests and debugging', tools),
  ],
};
