import { test, expect } from '@playwright/test';
import { expectStills } from './media.js';

const DOC_PATHS = [
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
  '/docs/zed/',
  '/ja/docs/zed/',
  '/zh/docs/zed/',
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

      await page.goto(docPath);

      expect(failedImages, `Screenshot request failed: ${JSON.stringify(failedImages)}`).toHaveLength(0);

      const screenshot = page.locator('img[src*="/assets/screenshots/"]').first();
      await expect(screenshot).toBeVisible();

      const src = await screenshot.getAttribute('src');
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

// [WEB-DESIGN-MEDIA] Each feature page opens on its still from the film kit
// (films/doc-stills.mjs): the real extension on the Shop demo, never an old capture.
const DOC_STILLS = {
  'architecture/': 'architecture',
  'editors/': 'editors',
  'configuration/': 'configuration',
  'completions/': 'completions',
  'hover/': 'hover',
  'go-to-definition/': 'navigation',
  'diagnostics/': 'diagnostics',
  'refactoring/': 'refactoring',
  'context-menus/': 'context-menus',
  'nuget/': 'nuget-browse',
};

test.describe('Docs stills', () => {
  for (const [page, still] of Object.entries(DOC_STILLS)) {
    for (const lang of ['', '/ja', '/zh']) {
      test(`${lang}/docs/${page} opens on the ${still} still, at full size with alt text`, async ({ page: browser }) => {
        await browser.goto(`${lang}/docs/${page}`);
        const shot = browser.locator('img[src^="/assets/screenshots/docs/"]');
        await expect(shot).toHaveCount(1);
        await expect(shot).toHaveAttribute('src', `/assets/screenshots/docs/${still}.webp`);
        await expect(shot).toHaveAttribute('width', '2400');
        await expect(shot).toHaveAttribute('height', '1500');
        await expectStills(shot);
      });
    }
  }

  for (const lang of ['', '/ja', '/zh']) {
    test(`${lang}/blog/introducing-sharplsp/ shows twelve current stills, none of the old captures`, async ({ page }) => {
      await page.goto(`${lang}/blog/introducing-sharplsp/`);
      const stills = page.locator('figure img[src^="/assets/screenshots/docs/"]');
      await expect(stills).toHaveCount(12);
      await expectStills(stills);
      await expect(page.locator('img[src$=".png"][src^="/assets/screenshots/"]')).toHaveCount(0);
    });
  }
});
