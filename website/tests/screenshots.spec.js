import { test, expect } from '@playwright/test';

const BASE = '/forge';

const IDES = ['vscode', 'zed'];

const SCREENSHOT_PAGES = [
  {
    path: `${BASE}/docs/completions/`,
    name: 'completions-page',
    description: 'completions page screenshot',
  },
  {
    path: `${BASE}/docs/diagnostics/`,
    name: 'diagnostics-page',
    description: 'diagnostics page screenshot',
  },
  {
    path: `${BASE}/docs/hover/`,
    name: 'hover-page',
    description: 'hover page screenshot',
  },
  {
    path: `${BASE}/docs/go-to-definition/`,
    name: 'go-to-definition-page',
    description: 'go-to-definition page screenshot',
  },
  {
    path: `${BASE}/docs/profiler/`,
    name: 'profiler-page',
    description: 'profiler page screenshot',
  },
];

test.describe('Screenshots load correctly', () => {
  for (const { path, name, description } of SCREENSHOT_PAGES) {
    for (const ide of IDES) {
      const imgPattern = new RegExp(`assets\\/screenshots\\/${ide}-${name}\\.png`);

      test(`${ide} ${description} is visible and loads at ${path}`, async ({ page }) => {
        const failedImages = [];
        page.on('response', (response) => {
          if (imgPattern.test(response.url()) && response.status() !== 200) {
            failedImages.push({ url: response.url(), status: response.status() });
          }
        });

        await page.goto(path);

        expect(failedImages, `Image request failed: ${JSON.stringify(failedImages)}`).toHaveLength(0);

        const img = page.locator(`img[src*="${ide}-${name}"]`);
        await expect(img).toBeVisible();

        const src = await img.getAttribute('src');
        expect(src, `Image src should not contain double prefix: ${src}`).not.toMatch(/\/forge\/forge\//);
        expect(src, `Image src should match expected pattern`).toMatch(imgPattern);

        const imgBoundingBox = await img.boundingBox();
        const h1 = page.locator('h1').first();
        const h1BoundingBox = await h1.boundingBox();
        expect(imgBoundingBox, 'Screenshot image should be positioned above h1').not.toBeNull();
        expect(h1BoundingBox, 'h1 heading should be present').not.toBeNull();
        expect(imgBoundingBox.y, 'Screenshot should appear above the h1 heading').toBeLessThan(h1BoundingBox.y);
      });
    }
  }

  test('screenshot images return HTTP 200 when fetched directly', async ({ page }) => {
    const screenshotPaths = [];
    for (const { name } of SCREENSHOT_PAGES) {
      for (const ide of IDES) {
        screenshotPaths.push(`${BASE}/assets/screenshots/${ide}-${name}.png`);
      }
    }

    for (const screenshotPath of screenshotPaths) {
      const response = await page.goto(`http://localhost:8081${screenshotPath}`);
      expect(response?.status(), `${screenshotPath} should return 200`).toBe(200);
    }
  });
});
