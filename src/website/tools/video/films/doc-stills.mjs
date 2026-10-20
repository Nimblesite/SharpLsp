// Implements [WEB-DESIGN-MEDIA]. The docs pages' and the launch post's stills
// (`screenshots/docs/<name>.webp`), shot on the Shop demo in the same isolated
// editor as the films: no clips, only clean frames of each feature at work.
//
//   node src/website/tools/video/film.mjs doc-stills
import fs from 'node:fs';
import path from 'node:path';
import { snap } from '../kit/camera.mjs';
import { ACTIONS, SUGGEST, clickOn, hoverOn } from '../kit/code.mjs';
import { runCommand } from '../kit/editor.mjs';
import { openMenu, unfold } from '../kit/acts/explorer.mjs';
import { LANGUAGE, hidePanel, navigate, reopen, setPane, showLog, typeText } from '../kit/acts/language.mjs';
import { AT_CHECKOUT, AT_PIPELINE, ready } from '../kit/acts/shop.mjs';
import { SHOP } from '../kit/set.mjs';
import { openFile, panel, sleep, typeAt } from '../kit/workbench.mjs';
import { configurationToml } from './configuration.mjs';

const CSHARP = /^Storefront \(Storefront\.csproj\)/;
const FSHARP = /^FsStorefront \(FsStorefront\.fsproj\)/;

/** Off camera: set the editor up with `act(shot)`, then take the still `name`. */
const take = (name, act, options) => ({
  offCamera: async (shot) => {
    await act(shot);
    await snap(shot, name, options);
  },
});

async function solutionTree({ page }) {
  await unfold(page, FSHARP);
  await unfold(page, CSHARP);
  await unfold(page, /^Storefront$/);
  await openFile(page, 'CheckoutPipeline.cs');
}

/** A clean `file` with `text` typed after `line`: the edit every code still starts from. */
async function typedInto(page, file, line, text) {
  await reopen(file)({ page });
  await typeAt(page, { line, append: true, text });
}

/** `text` typed into `file` after `line` ends on a trigger character; the list it opens, narrowed by `filter`. */
const completing = (file, line, text, filter) => async ({ page }) => {
  await typedInto(page, file, line, text);
  await page.locator(SUGGEST).waitFor({ timeout: 15_000 });
  await typeText(page, filter, 110);
  await sleep(1200);
};

/** `text` typed into `file` after `line`, then the quick fixes (Cmd+.) at `spot`. */
const fixing = (file, line, text, spot) => async ({ page }) => {
  await typedInto(page, file, line, text);
  await page.keyboard.press('Escape');
  await sleep(2500);
  await clickOn(page, spot);
  await page.keyboard.press('Meta+.');
  await page.locator(ACTIONS).first().waitFor({ timeout: 30_000 });
  await sleep(1500);
};

async function nugetInstalled({ page }) {
  const browser = panel(page);
  await browser.locator('.btn-primary', { hasText: 'Install' }).click();
  await browser.locator('.btn-danger', { hasText: 'Remove' }).waitFor({ timeout: 180_000 });
  await browser.getByText('Installed', { exact: true }).first().click();
  await sleep(4000);
}

async function problems({ page }) {
  await typedInto(page, 'Checkout.fs', 22, '\n\nlet count: int = "12"');
  await openFile(page, 'CheckoutPipeline.cs');
  await typeAt(page, { line: 12, append: true, text: '\n        int items = "twelve";' });
  await page.keyboard.press('Escape');
  await sleep(4000);
  await page.keyboard.press('Meta+Shift+M');
  await sleep(2000);
}

async function nugetBrowser({ page }) {
  await openMenu(page, FSHARP);
  await page.locator('.monaco-menu .action-label').filter({ hasText: /^Browse NuGet Packages$/ }).first().click();
  await panel(page).locator('.package-item').first().waitFor({ timeout: 60_000 });
  await sleep(4000);
}

async function nugetPackage({ page }) {
  const browser = panel(page);
  await browser.locator('#searchInput').click();
  await typeText(page, 'FsToolkit.ErrorHandling', 50);
  await browser.locator('.package-item', { hasText: 'FsToolkit.ErrorHandling' }).first().click();
  await browser.locator('.btn-primary', { hasText: 'Install' }).waitFor({ timeout: 60_000 });
  await sleep(4000);
}

export default {
  name: 'doc-stills',
  demo: SHOP,
  settings: LANGUAGE,
  stillsFolder: 'docs',
  scenes: [
    { offCamera: ({ workspace }) => fs.writeFileSync(path.join(workspace, 'sharplsp.toml'), configurationToml) },
    ...ready(AT_PIPELINE, AT_CHECKOUT),
    take('solution-explorer', solutionTree),
    take('type-members', ({ page }) => unfold(page, /^CustomerSession$/)),
    take('context-menus', ({ page }) => openMenu(page, CSHARP)),
    take('hover', async ({ page }) => {
      await page.keyboard.press('Escape');
      // The launch post points at the Processes view beside the hover.
      await setPane(page, 'Processes', true);
      await openFile(page, 'Program.cs');
      await hoverOn(page, { line: 5, word: 'Generate' });
      await sleep(1200);
    }, { hovering: true }),
    take('completions', async (shot) => {
      await setPane(shot.page, 'Processes', false);
      await completing('Checkout.fs', 21, '\n\nlet cheapest (basket: Product list) =\n    basket |> List.', 'min')(shot);
    }),
    take('completions-csharp', completing('CheckoutPipeline.cs', 14, '\n\n    public static Product Cheapest(List<Product> basket) =>\n        basket.', 'Min')),
    take('definition', async ({ page }) => {
      await reopen('Program.cs')({ page });
      await navigate(page, { line: 10, word: 'Checkout' }, 'F12');
      await sleep(1500);
    }),
    take('navigation', async ({ page }) => {
      await reopen('CheckoutPipeline.cs')({ page });
      await navigate(page, { line: 16, word: 'Product' }, 'Shift+F12');
      await page.locator('.peekview-widget').first().waitFor();
      await sleep(2000);
    }),
    take('diagnostics', problems),
    take('refactoring', async (shot) => {
      await hidePanel(shot.page);
      await fixing('Sessions.fs', 10, '\n\nlet describe stage =\n    match stage with\n    | Browsing -> "still browsing"', { line: 13, word: 'match' })(shot);
    }),
    take('refactoring-csharp', async (shot) => {
      await shot.page.keyboard.press('Escape');
      await fixing('CheckoutPipeline.cs', 12, '\n        var receipt = Receipt(invoice);', { line: 13, word: 'Receipt' })(shot);
    }),
    take('code-folding', async ({ page }) => {
      await page.keyboard.press('Escape');
      await reopen('CheckoutPipeline.cs')({ page });
      for (const key of ['Meta+K', 'Meta+0']) await page.keyboard.press(key);
      await sleep(1500);
    }),
    take('architecture', async ({ page }) => {
      for (const key of ['Meta+K', 'Meta+J']) await page.keyboard.press(key);
      await showLog(page, 'method=textDocument/hover');
      await openFile(page, 'Checkout.fs');
      await hoverOn(page, { line: 13, word: 'pickBasket' });
      await openFile(page, 'CheckoutPipeline.cs');
      await hoverOn(page, { line: 11, word: 'PriceBasket' });
      await sleep(1500);
    }, { hovering: true }),
    take('configuration', async ({ page }) => {
      await hidePanel(page);
      await reopen('sharplsp.toml')({ page });
      await sleep(1500);
    }),
    take('editors', async ({ page }) => {
      await page.locator('.command-center .command-center-center').click();
      await typeText(page, '>SharpLsp', 60);
      await sleep(2500);
    }),
    take('nuget-browse', async (shot) => {
      await shot.page.keyboard.press('Escape');
      await nugetBrowser(shot);
    }),
    take('nuget-package', nugetPackage),
    take('nuget-installed', nugetInstalled),
  ],
};
