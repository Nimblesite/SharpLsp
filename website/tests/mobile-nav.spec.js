import { test, expect } from '@playwright/test';

// The dev server runs with --pathPrefix /forge/ (matching GitHub Pages deployment).
// All pages are served under /forge/ on localhost.
const BASE = '/forge';

const MOBILE_VIEWPORTS = [
  { name: 'iPhone SE (375px)', width: 375, height: 667 },
  { name: 'iPhone 14 (390px)', width: 390, height: 844 },
  { name: 'Android (360px)', width: 360, height: 800 },
];

for (const viewport of MOBILE_VIEWPORTS) {
  test.describe(`Mobile nav — ${viewport.name}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test('hamburger button is visible on homepage', async ({ page }) => {
      await page.goto(`${BASE}/`);
      const toggle = page.locator('#mobile-menu-toggle');
      await expect(toggle).toBeVisible();
    });

    test('nav links are hidden by default on homepage', async ({ page }) => {
      await page.goto(`${BASE}/`);
      const navLinks = page.locator('.nav-links');
      await expect(navLinks).not.toBeVisible();
    });

    test('clicking hamburger reveals nav links', async ({ page }) => {
      await page.goto(`${BASE}/`);
      const toggle = page.locator('#mobile-menu-toggle');
      const navLinks = page.locator('.nav-links');

      await toggle.click();
      await expect(navLinks).toBeVisible();
    });

    test('nav links contain Docs, Blog, GitHub links', async ({ page }) => {
      await page.goto(`${BASE}/`);
      const toggle = page.locator('#mobile-menu-toggle');
      await toggle.click();

      const navLinks = page.locator('.nav-links');
      await expect(navLinks.locator('a[href*="/docs"]')).toBeVisible();
      await expect(navLinks.locator('a[href*="/blog"]')).toBeVisible();
      await expect(navLinks.locator('a[href*="github.com"]')).toBeVisible();
    });

    test('clicking hamburger again hides nav links', async ({ page }) => {
      await page.goto(`${BASE}/`);
      const toggle = page.locator('#mobile-menu-toggle');
      const navLinks = page.locator('.nav-links');

      await toggle.click();
      await expect(navLinks).toBeVisible();

      await toggle.click();
      await expect(navLinks).not.toBeVisible();
    });

    test('hamburger aria-expanded state toggles correctly', async ({ page }) => {
      await page.goto(`${BASE}/`);
      const toggle = page.locator('#mobile-menu-toggle');

      await expect(toggle).not.toHaveAttribute('aria-expanded', 'true');

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');

      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    test('can navigate to docs page via mobile nav', async ({ page }) => {
      await page.goto(`${BASE}/`);
      const toggle = page.locator('#mobile-menu-toggle');
      await toggle.click();

      await page.locator('.nav-links a[href*="/docs"]').click();
      await expect(page).toHaveURL(/\/docs/);
    });

    test('hamburger is visible on docs page', async ({ page }) => {
      await page.goto(`${BASE}/docs/`);
      const toggle = page.locator('#mobile-menu-toggle');
      await expect(toggle).toBeVisible();
    });

    test('clicking hamburger on docs page reveals nav links', async ({ page }) => {
      await page.goto(`${BASE}/docs/`);
      const toggle = page.locator('#mobile-menu-toggle');
      await toggle.click();

      const navLinks = page.locator('.nav-links');
      await expect(navLinks).toBeVisible();
    });

    test('all new docs pages are accessible on mobile', async ({ page }) => {
      const docsPaths = [
        `${BASE}/docs/`,
        `${BASE}/docs/architecture/`,
        `${BASE}/docs/editors/`,
        `${BASE}/docs/completions/`,
        `${BASE}/docs/diagnostics/`,
        `${BASE}/docs/hover/`,
        `${BASE}/docs/go-to-definition/`,
        `${BASE}/docs/fsharp/`,
        `${BASE}/docs/configuration/`,
      ];

      for (const path of docsPaths) {
        const response = await page.goto(path);
        expect(response?.status(), `${path} should return 200`).toBe(200);
        await expect(page.locator('#mobile-menu-toggle')).toBeVisible();
      }
    });
  });
}

test.describe('Desktop nav (sanity check)', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('hamburger is hidden on desktop', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const toggle = page.locator('#mobile-menu-toggle');
    await expect(toggle).not.toBeVisible();
  });

  test('nav links are visible on desktop without clicking anything', async ({ page }) => {
    await page.goto(`${BASE}/`);
    const navLinks = page.locator('.nav-links');
    await expect(navLinks).toBeVisible();
  });
});
