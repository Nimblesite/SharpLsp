import { test, expect } from '@playwright/test';
import { docsSidebar, openDocsMenu } from './docs-menu.js';

// E2E coverage for the F# / FSAC parity docs page (/docs/fsharp/).
// Proves the page ships, renders the parity content, and is reachable from
// the docs sidebar — so the "document all F# features" requirement cannot
// silently regress.

/** Open the F# docs page and expect its body to contain every one of `texts`. */
async function expectPageTexts(page, texts) {
  await page.goto('/docs/fsharp/');
  const body = page.locator('body');
  for (const text of texts) await expect(body).toContainText(text);
}

test.describe('F# Language Support docs page', () => {
  test('page returns 200 and renders the F# heading', async ({ page }) => {
    const response = await page.goto('/docs/fsharp/');
    expect(response?.status(), '/docs/fsharp/ should return 200').toBe(200);
    await expect(page.locator('.prose h1')).toContainText('F# Language Support');
  });

  test('documents the FSAC parity surface', async ({ page }) => {
    // Engines and named features must all be documented.
    await expectPageTexts(page, [
      'FsAutoComplete',
      'Fantomas',
      'F# Compiler Service',
      'Signature help',
      'Inlay Hints',
      'Semantic Tokens',
      'Code Lens',
      'Call Hierarchy',
      'Type Hierarchy',
      'F# Interactive',
    ]);
  });

  test('calls out the beyond-FSAC differentiators', async ({ page }) => {
    // Project-wide scope and pipeline hints are SharpLsp's edge over FSAC.
    await expectPageTexts(page, ['project-wide', 'Pipeline', 'Editor-Agnostic']);
  });

  test('lists the quick-fix matrix with FCS diagnostic codes', async ({ page }) => {
    await expectPageTexts(page, ['FS0039', 'FS0025', 'FS1182']);
  });

  test('appears in the docs sidebar and is reachable by click', async ({ page }) => {
    await page.goto('/docs/');
    const fsharpLink = docsSidebar(page).locator('a[href$="/docs/fsharp/"]');
    await openDocsMenu(page);

    await expect(fsharpLink).toBeVisible();
    await expect(fsharpLink).toContainText('F#');

    await fsharpLink.click();
    await expect(page).toHaveURL(/\/docs\/fsharp\/$/);
    // The active sidebar item reflects the current page.
    await expect(docsSidebar(page).locator('a.active')).toContainText('F#');
  });
});
