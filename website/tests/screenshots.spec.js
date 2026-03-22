import { test, expect } from '@playwright/test';

const BASE = '/forge';

const SCREENSHOT_PAGES = [
  {
    path: `${BASE}/docs/completions/`,
    imgSrc: /assets\/screenshots\/completions-page\.png/,
    description: 'completions page screenshot',
  },
  {
    path: `${BASE}/docs/diagnostics/`,
    imgSrc: /assets\/screenshots\/diagnostics-page\.png/,
    description: 'diagnostics page screenshot',
  },
  {
    path: `${BASE}/docs/hover/`,
    imgSrc: /assets\/screenshots\/hover-page\.png/,
    description: 'hover page screenshot',
  },
  {
    path: `${BASE}/docs/go-to-definition/`,
    imgSrc: /assets\/screenshots\/go-to-definition-page\.png/,
    description: 'go-to-definition page screenshot',
  },
];

test.describe('Screenshots load correctly', () => {
  for (const { path, imgSrc, description } of SCREENSHOT_PAGES) {
    test(`${description} is visible and loads at top of ${path}`, async ({ page }) => {
      const failedImages = [];
      page.on('response', (response) => {
        if (imgSrc.test(response.url()) && response.status() !== 200) {
          failedImages.push({ url: response.url(), status: response.status() });
        }
      });

      await page.goto(path);

      // Verify no screenshot images failed to load
      expect(failedImages, `Image request failed: ${JSON.stringify(failedImages)}`).toHaveLength(0);

      // Verify the img element is present and visible
      const img = page.locator(`img[src*="screenshots"]`).first();
      await expect(img).toBeVisible();

      // Verify the image src does not contain a double prefix (/forge/forge/)
      const src = await img.getAttribute('src');
      expect(src, `Image src should not contain double prefix: ${src}`).not.toMatch(/\/forge\/forge\//);
      expect(src, `Image src should match expected pattern`).toMatch(imgSrc);

      // Verify the image appears before the h1 heading (at the top)
      const imgBoundingBox = await img.boundingBox();
      const h1 = page.locator('h1').first();
      const h1BoundingBox = await h1.boundingBox();
      expect(imgBoundingBox, 'Screenshot image should be positioned above h1').not.toBeNull();
      expect(h1BoundingBox, 'h1 heading should be present').not.toBeNull();
      expect(imgBoundingBox.y, 'Screenshot should appear above the h1 heading').toBeLessThan(h1BoundingBox.y);
    });
  }

  test('screenshot images return HTTP 200 when fetched directly', async ({ page }) => {
    const screenshotPaths = [
      `${BASE}/assets/screenshots/completions-page.png`,
      `${BASE}/assets/screenshots/diagnostics-page.png`,
      `${BASE}/assets/screenshots/hover-page.png`,
      `${BASE}/assets/screenshots/go-to-definition-page.png`,
    ];

    for (const screenshotPath of screenshotPaths) {
      const response = await page.goto(`http://localhost:8081${screenshotPath}`);
      expect(response?.status(), `${screenshotPath} should return 200`).toBe(200);
    }
  });
});
