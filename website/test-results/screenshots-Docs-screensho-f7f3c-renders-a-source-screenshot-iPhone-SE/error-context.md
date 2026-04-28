# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: screenshots.spec.js >> Docs screenshots >> /zh/docs/go-to-definition/ renders a source screenshot
- Location: tests/screenshots.spec.js:31:5

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: locator('img[src*="/assets/screenshots/"]').first()
Expected: visible
Timeout: 5000ms
Error: element(s) not found

Call log:
  - Expect "toBeVisible" with timeout 5000ms
  - waiting for locator('img[src*="/assets/screenshots/"]').first()

```

# Page snapshot

```yaml
- generic [ref=e2]: Cannot GET /forge/zh/docs/go-to-definition/
```

# Test source

```ts
  1  | import { test, expect } from '@playwright/test';
  2  | 
  3  | const BASE = '/forge';
  4  | 
  5  | const DOC_PATHS = [
  6  |   '/docs/',
  7  |   '/docs/architecture/',
  8  |   '/docs/editors/',
  9  |   '/docs/completions/',
  10 |   '/docs/diagnostics/',
  11 |   '/docs/hover/',
  12 |   '/docs/go-to-definition/',
  13 |   '/docs/refactoring/',
  14 |   '/docs/nuget/',
  15 |   '/docs/context-menus/',
  16 |   '/docs/configuration/',
  17 |   '/docs/profiler/',
  18 |   '/zh/docs/',
  19 |   '/zh/docs/architecture/',
  20 |   '/zh/docs/editors/',
  21 |   '/zh/docs/completions/',
  22 |   '/zh/docs/diagnostics/',
  23 |   '/zh/docs/hover/',
  24 |   '/zh/docs/go-to-definition/',
  25 |   '/zh/docs/configuration/',
  26 |   '/zh/docs/profiler/',
  27 | ];
  28 | 
  29 | test.describe('Docs screenshots', () => {
  30 |   for (const docPath of DOC_PATHS) {
  31 |     test(`${docPath} renders a source screenshot`, async ({ page }) => {
  32 |       const failedImages = [];
  33 | 
  34 |       page.on('response', (response) => {
  35 |         if (response.url().includes('/assets/screenshots/') && response.status() !== 200) {
  36 |           failedImages.push({ url: response.url(), status: response.status() });
  37 |         }
  38 |       });
  39 | 
  40 |       await page.goto(`${BASE}${docPath}`);
  41 | 
  42 |       expect(failedImages, `Screenshot request failed: ${JSON.stringify(failedImages)}`).toHaveLength(0);
  43 | 
  44 |       const screenshot = page.locator('img[src*="/assets/screenshots/"]').first();
> 45 |       await expect(screenshot).toBeVisible();
     |                                ^ Error: expect(locator).toBeVisible() failed
  46 | 
  47 |       const src = await screenshot.getAttribute('src');
  48 |       expect(src, `Image src should not contain double prefix: ${src}`).not.toMatch(/\/forge\/forge\//);
  49 |       expect(src, `Image src should point at screenshot assets`).toContain('/assets/screenshots/');
  50 | 
  51 |       const rendered = await screenshot.evaluate((img) => ({
  52 |         complete: img.complete,
  53 |         naturalWidth: img.naturalWidth,
  54 |         naturalHeight: img.naturalHeight,
  55 |       }));
  56 | 
  57 |       expect(rendered.complete, `Screenshot should finish loading: ${src}`).toBe(true);
  58 |       expect(rendered.naturalWidth, `Screenshot should have pixel width: ${src}`).toBeGreaterThan(0);
  59 |       expect(rendered.naturalHeight, `Screenshot should have pixel height: ${src}`).toBeGreaterThan(0);
  60 |     });
  61 |   }
  62 | });
  63 | 
```