# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: mobile-nav.spec.js >> Mobile nav — Android (360px) >> hamburger button is visible on homepage
- Location: tests/mobile-nav.spec.js:17:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('#mobile-menu-toggle')
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('#mobile-menu-toggle')

```

# Page snapshot

```yaml
- generic [ref=e2]: Cannot GET /forge/
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | 
  3   | // The dev server runs with --pathPrefix /forge/ (matching GitHub Pages deployment).
  4   | // All pages are served under /forge/ on localhost.
  5   | const BASE = '/forge';
  6   | 
  7   | const MOBILE_VIEWPORTS = [
  8   |   { name: 'iPhone SE (375px)', width: 375, height: 667 },
  9   |   { name: 'iPhone 14 (390px)', width: 390, height: 844 },
  10  |   { name: 'Android (360px)', width: 360, height: 800 },
  11  | ];
  12  | 
  13  | for (const viewport of MOBILE_VIEWPORTS) {
  14  |   test.describe(`Mobile nav — ${viewport.name}`, () => {
  15  |     test.use({ viewport: { width: viewport.width, height: viewport.height } });
  16  | 
  17  |     test('hamburger button is visible on homepage', async ({ page }) => {
  18  |       await page.goto(`${BASE}/`);
  19  |       const toggle = page.locator('#mobile-menu-toggle');
> 20  |       await expect(toggle).toBeVisible();
      |                            ^ Error: expect(locator).toBeVisible() failed
  21  |     });
  22  | 
  23  |     test('nav links are hidden by default on homepage', async ({ page }) => {
  24  |       await page.goto(`${BASE}/`);
  25  |       const navLinks = page.locator('.nav-links');
  26  |       await expect(navLinks).not.toBeVisible();
  27  |     });
  28  | 
  29  |     test('clicking hamburger reveals nav links', async ({ page }) => {
  30  |       await page.goto(`${BASE}/`);
  31  |       const toggle = page.locator('#mobile-menu-toggle');
  32  |       const navLinks = page.locator('.nav-links');
  33  | 
  34  |       await toggle.click();
  35  |       await expect(navLinks).toBeVisible();
  36  |     });
  37  | 
  38  |     test('nav links contain Docs, Blog, GitHub links', async ({ page }) => {
  39  |       await page.goto(`${BASE}/`);
  40  |       const toggle = page.locator('#mobile-menu-toggle');
  41  |       await toggle.click();
  42  | 
  43  |       const navLinks = page.locator('.nav-links');
  44  |       await expect(navLinks.locator('a[href*="/docs"]')).toBeVisible();
  45  |       await expect(navLinks.locator('a[href*="/blog"]')).toBeVisible();
  46  |       await expect(navLinks.locator('a[href*="github.com"]')).toBeVisible();
  47  |     });
  48  | 
  49  |     test('clicking hamburger again hides nav links', async ({ page }) => {
  50  |       await page.goto(`${BASE}/`);
  51  |       const toggle = page.locator('#mobile-menu-toggle');
  52  |       const navLinks = page.locator('.nav-links');
  53  | 
  54  |       await toggle.click();
  55  |       await expect(navLinks).toBeVisible();
  56  | 
  57  |       await toggle.click();
  58  |       await expect(navLinks).not.toBeVisible();
  59  |     });
  60  | 
  61  |     test('hamburger aria-expanded state toggles correctly', async ({ page }) => {
  62  |       await page.goto(`${BASE}/`);
  63  |       const toggle = page.locator('#mobile-menu-toggle');
  64  | 
  65  |       await expect(toggle).not.toHaveAttribute('aria-expanded', 'true');
  66  | 
  67  |       await toggle.click();
  68  |       await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  69  | 
  70  |       await toggle.click();
  71  |       await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  72  |     });
  73  | 
  74  |     test('can navigate to docs page via mobile nav', async ({ page }) => {
  75  |       await page.goto(`${BASE}/`);
  76  |       const toggle = page.locator('#mobile-menu-toggle');
  77  |       await toggle.click();
  78  | 
  79  |       await page.locator('.nav-links a[href*="/docs"]').click();
  80  |       await expect(page).toHaveURL(/\/docs/);
  81  |     });
  82  | 
  83  |     test('hamburger is visible on docs page', async ({ page }) => {
  84  |       await page.goto(`${BASE}/docs/`);
  85  |       const toggle = page.locator('#mobile-menu-toggle');
  86  |       await expect(toggle).toBeVisible();
  87  |     });
  88  | 
  89  |     test('clicking hamburger on docs page reveals nav links', async ({ page }) => {
  90  |       await page.goto(`${BASE}/docs/`);
  91  |       const toggle = page.locator('#mobile-menu-toggle');
  92  |       await toggle.click();
  93  | 
  94  |       const navLinks = page.locator('.nav-links');
  95  |       await expect(navLinks).toBeVisible();
  96  |     });
  97  | 
  98  |     test('all new docs pages are accessible on mobile', async ({ page }) => {
  99  |       const docsPaths = [
  100 |         `${BASE}/docs/`,
  101 |         `${BASE}/docs/architecture/`,
  102 |         `${BASE}/docs/editors/`,
  103 |         `${BASE}/docs/completions/`,
  104 |         `${BASE}/docs/diagnostics/`,
  105 |         `${BASE}/docs/hover/`,
  106 |         `${BASE}/docs/go-to-definition/`,
  107 |         `${BASE}/docs/configuration/`,
  108 |       ];
  109 | 
  110 |       for (const path of docsPaths) {
  111 |         const response = await page.goto(path);
  112 |         expect(response?.status(), `${path} should return 200`).toBe(200);
  113 |         await expect(page.locator('#mobile-menu-toggle')).toBeVisible();
  114 |       }
  115 |     });
  116 |   });
  117 | }
  118 | 
  119 | test.describe('Desktop nav (sanity check)', () => {
  120 |   test.use({ viewport: { width: 1280, height: 800 } });
```