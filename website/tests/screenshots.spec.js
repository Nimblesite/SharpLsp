import { test, expect } from '@playwright/test';

const BASE = '/forge';

const DOC_PATHS = [
  '/docs/',
  '/docs/architecture/',
  '/docs/editors/',
  '/docs/completions/',
  '/docs/diagnostics/',
  '/docs/hover/',
  '/docs/go-to-definition/',
  '/docs/refactoring/',
  '/docs/nuget/',
  '/docs/context-menus/',
  '/docs/configuration/',
  '/docs/profiler/',
  '/zh/docs/',
  '/zh/docs/architecture/',
  '/zh/docs/editors/',
  '/zh/docs/completions/',
  '/zh/docs/diagnostics/',
  '/zh/docs/hover/',
  '/zh/docs/go-to-definition/',
  '/zh/docs/configuration/',
  '/zh/docs/profiler/',
];

test.describe('Docs screenshots', () => {
  for (const docPath of DOC_PATHS) {
    test(`${docPath} renders a source screenshot`, async ({ page }) => {
      const failedImages = [];

      page.on('response', (response) => {
        if (response.url().includes('/assets/screenshots/') && response.status() !== 200) {
          failedImages.push({ url: response.url(), status: response.status() });
        }
      });

      await page.goto(`${BASE}${docPath}`);

      expect(failedImages, `Screenshot request failed: ${JSON.stringify(failedImages)}`).toHaveLength(0);

      const screenshot = page.locator('img[src*="/assets/screenshots/"]').first();
      await expect(screenshot).toBeVisible();

      const src = await screenshot.getAttribute('src');
      expect(src, `Image src should not contain double prefix: ${src}`).not.toMatch(/\/forge\/forge\//);
      expect(src, `Image src should point at screenshot assets`).toContain('/assets/screenshots/');

      const rendered = await screenshot.evaluate((img) => ({
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
      }));

      expect(rendered.complete, `Screenshot should finish loading: ${src}`).toBe(true);
      expect(rendered.naturalWidth, `Screenshot should have pixel width: ${src}`).toBeGreaterThan(0);
      expect(rendered.naturalHeight, `Screenshot should have pixel height: ${src}`).toBeGreaterThan(0);
    });
  }
});
