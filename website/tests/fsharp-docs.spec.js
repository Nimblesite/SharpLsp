import { test, expect } from '@playwright/test';

// E2E coverage for the F# / FSAC parity docs page (/docs/fsharp/).
// Proves the page ships, renders the parity content, and is reachable from
// the docs sidebar — so the "document all F# features" requirement cannot
// silently regress.

test.describe('F# Language Support docs page', () => {
  test('page returns 200 and renders the F# heading', async ({ page }) => {
    const response = await page.goto('/docs/fsharp/');
    expect(response?.status(), '/docs/fsharp/ should return 200').toBe(200);
    await expect(page.locator('.prose h1')).toContainText('F# Language Support');
  });

  test('documents the FSAC parity surface', async ({ page }) => {
    await page.goto('/docs/fsharp/');
    const body = page.locator('body');
    // Engines and named features must all be documented.
    await expect(body).toContainText('FsAutoComplete');
    await expect(body).toContainText('Fantomas');
    await expect(body).toContainText('F# Compiler Service');
    await expect(body).toContainText('Signature help');
    await expect(body).toContainText('Inlay Hints');
    await expect(body).toContainText('Semantic Tokens');
    await expect(body).toContainText('Code Lens');
    await expect(body).toContainText('Call Hierarchy');
    await expect(body).toContainText('Type Hierarchy');
    await expect(body).toContainText('F# Interactive');
  });

  test('calls out the beyond-FSAC differentiators', async ({ page }) => {
    await page.goto('/docs/fsharp/');
    const body = page.locator('body');
    // Project-wide scope and pipeline hints are SharpLsp's edge over FSAC.
    await expect(body).toContainText('project-wide');
    await expect(body).toContainText('Pipeline');
    await expect(body).toContainText('Editor-Agnostic');
  });

  test('lists the quick-fix matrix with FCS diagnostic codes', async ({ page }) => {
    await page.goto('/docs/fsharp/');
    const body = page.locator('body');
    await expect(body).toContainText('FS0039');
    await expect(body).toContainText('FS0025');
    await expect(body).toContainText('FS1182');
  });

  test('appears in the docs sidebar and is reachable by click', async ({ page }) => {
    await page.goto('/docs/');
    const sidebar = page.locator('#docs-sidebar');
    const fsharpLink = sidebar.locator('a[href$="/docs/fsharp/"]');
    await expect(fsharpLink).toBeVisible();
    await expect(fsharpLink).toContainText('F#');

    await fsharpLink.click();
    await expect(page).toHaveURL(/\/docs\/fsharp\/$/);
    // The active sidebar item reflects the current page.
    await expect(page.locator('#docs-sidebar a.active')).toContainText('F#');
  });
});
