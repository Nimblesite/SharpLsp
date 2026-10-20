// Implements [WEB-DESIGN-MEDIA] and shows [RAZOR-FEATURES]. The "Blazor and
// Razor" walkthrough (`blazor`): C# hover, completion, diagnostics, navigation
// and rename inside a Blazor component's markup and `@code` block, HTML from
// VS Code's own HTML service, a component's definition reached from C#, and
// linked tag editing and folding.
//
//   node src/website/tools/video/film.mjs blazor
import { snap } from '../../kit/camera.mjs';
import { clickOn, hoverOn } from '../../kit/code.mjs';
import { LANGUAGE, hidePanel, hoverEach, navigate, peekReferences, renameTo, scene, typeText, typeThroughCompletion } from '../../kit/acts/language.mjs';
import { ready } from '../../kit/acts/shop.mjs';
import { BLAZOR_STOREFRONT } from '../../kit/set.mjs';
import { goTo, openFile, sleep, typeAt } from '../../kit/workbench.mjs';

const BASKET = 'Basket.razor';
const AT_BASKET = [BASKET, { line: 18, word: 'Total' }];
const AT_PROGRAM = ['Program.cs', { line: 8, word: 'MapRazorComponents' }];

/** Line 19: the cheapest product, typed through LINQ's members and then the record's. */
const cheapest = ({ page }) =>
  typeThroughCompletion(page, 18, '\n<p>Cheapest: @(basket.', [
    ['MinB', '(product => product.'],
    ['Pri', ')?.Name)</p>'],
  ]);

/** Line 20: an element named through VS Code's HTML completion, then an HTML hover on `<ul>`. */
async function html({ page }) {
  await typeThroughCompletion(page, 19, '\n<', [['stro', '>Free delivery on every order</strong>']]);
  await hoverOn(page, { line: 8, word: 'ul' });
  await sleep(3500);
}

/** Line 21: a misspelt call, its error in a hover and in the Problems panel, then the line deleted again. */
async function mistake({ page }) {
  await typeAt(page, { line: 20, append: true, text: '\n<p>@Totl()</p>' });
  await page.keyboard.press('Escape');
  await sleep(3500);
  await hoverOn(page, { line: 21, word: 'Totl' });
  await sleep(3500);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Meta+Shift+M');
  await sleep(3500);
  await hidePanel(page);
  await goTo(page, 21);
  await page.keyboard.press('Meta+Shift+K');
  await sleep(2500);
}

/** F12 from the button's handler into `@code`, then every reference to the basket. */
async function definitionAndReferences({ page }) {
  await navigate(page, { line: 13, word: 'Add' }, 'F12');
  await sleep(2500);
  await peekReferences(page, { line: 23, word: 'basket' });
}

/** The basket field renamed in `@code`; its first use in the markup, hovered by the new name. */
async function rename({ page }) {
  await renameTo(page, { line: 23, word: 'basket' }, 'cart');
  await hoverOn(page, { line: 18, word: 'cart' });
  await sleep(3000);
}

/** Program.cs: F12 on the root component lands in App.razor. */
async function fromCSharp({ page }) {
  await openFile(page, 'Program.cs');
  await sleep(800);
  await navigate(page, { line: 8, word: 'App' }, 'F12');
  await sleep(3500);
}

/** `<ul>` renamed to `<ol>`, its end tag following, then the `@code` block folded. */
async function linkedAndFolded({ page }) {
  await openFile(page, BASKET);
  await clickOn(page, { line: 8, word: 'ul' });
  await page.keyboard.press('Meta+D');
  await sleep(600);
  await typeText(page, 'ol', 220);
  await sleep(2500);
  await clickOn(page, { line: 22, word: 'code' });
  await page.keyboard.press('Meta+Alt+BracketLeft');
  await sleep(3000);
}

export default {
  name: 'blazor',
  demo: BLAZOR_STOREFRONT,
  // VS Code's default bracket closing: Razor's language configuration closes `(`, so an
  // expression stays balanced as it is typed, and each typed `)` steps over its closer.
  settings: { ...LANGUAGE, 'editor.linkedEditing': true, 'editor.autoClosingBrackets': 'languageDefined' },
  narration: 'narration.json',
  stillsFolder: 'docs',
  poster: { scene: 'hover', at: 4 },
  scenes: [
    ...ready(AT_BASKET, AT_PROGRAM),
    { offCamera: ({ page }) => openFile(page, BASKET) },
    scene('hover', 1, 'C# in markup: Roslyn hovers, with your XML docs', ({ page }) =>
      hoverEach(page, [{ line: 18, word: 'Total' }, { line: 9, word: 'Products' }], { hold: 3200 }),
    ),
    {
      offCamera: async (shot) => {
        await hoverOn(shot.page, { line: 18, word: 'Total' });
        await sleep(1200);
        await snap(shot, 'blazor', { hovering: true });
      },
    },
    scene('complete', 2, 'Completion inside @ expressions, edits in the .razor file', cheapest),
    scene('html', 3, "HTML completion and hover from VS Code's HTML service", html),
    scene('errors', 4, 'C# errors land on the Razor line that caused them', mistake),
    scene('navigate', 5, 'F12 into @code, and every reference in the markup', definitionAndReferences),
    scene('rename', 6, 'Rename a @code field: every use in the markup follows', rename),
    scene('csharp', 7, "From C#, a component's definition is its .razor file", fromCSharp),
    scene('structure', 8, 'Linked tag editing, and folding for elements and @code', linkedAndFolded),
  ],
};
