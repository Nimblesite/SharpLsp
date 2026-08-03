import { test, expect } from '@playwright/test';

const HOMEPAGE_WIDTHS = [320, 360, 390, 768, 1440];

test.describe('Site layout regressions', () => {
  test('homepage leads with the complete .NET alternative and a real product screenshot', async ({ page }) => {
    await page.goto('/');

    const main = page.locator('main');
    const heading = main.getByRole('heading', { level: 1 });

    await expect(heading).toHaveCount(1);
    await expect(heading).toContainText(/complete \.NET development experience/i);
    await expect(heading).toContainText(/your editor/i);
    await expect(main).toContainText(/open-source alternative to Visual Studio, Rider, and C# Dev Kit/i);
    await expect(main).toContainText(/C# and F#/i);

    const installLinks = main.getByRole('link', { name: 'Install in VS Code' });
    const guideLinks = main.getByRole('link', { name: 'Installation guide' });
    await expect(installLinks).toHaveCount(2);
    await expect(installLinks.first()).toHaveAttribute('href', 'vscode:extension/nimblesite.sharplsp');
    await expect(guideLinks).toHaveCount(2);
    await expect(guideLinks.first()).toHaveAttribute('href', '/docs/');

    const screenshot = page.locator('.product-shot img[src^="/assets/screenshots/"]');
    await expect(screenshot).toHaveCount(1);
    await expect(screenshot).toBeVisible();
    await expect(screenshot).toHaveAttribute('alt', /SharpLsp/i);
    await expect(screenshot).toHaveAttribute('src', /\/assets\/screenshots\/.+\.(png|webp)$/i);

    const image = await screenshot.evaluate((element) => ({
      complete: element.complete,
      height: element.naturalHeight,
      width: element.naturalWidth,
    }));
    expect(image.complete).toBe(true);
    expect(image.width).toBeGreaterThan(1000);
    expect(image.height).toBeGreaterThan(500);
  });

  test('homepage has no page-level horizontal overflow at supported widths', async ({ page }) => {
    await page.setViewportSize({ width: HOMEPAGE_WIDTHS[0], height: 900 });
    await page.goto('/');

    for (const width of HOMEPAGE_WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      const dimensions = await page.evaluate(() => ({
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
      }));

      expect(dimensions.scrollWidth, `homepage overflows at ${width}px`).toBeLessThanOrEqual(dimensions.clientWidth);
    }
  });

  test('blog index uses the card grid, features the newest post, and filters posts', async ({ page }) => {
    await page.goto('/blog/');

    const cards = page.locator('.blog-grid > .post-card');
    const cardCount = await cards.count();

    expect(cardCount).toBeGreaterThan(1);
    await expect(page.locator('.post-list > .blog-post')).toHaveCount(0);
    await expect(page.locator('.blog-grid > .post-card-featured')).toHaveCount(1);
    await expect(cards.first()).toHaveClass(/\bpost-card-featured\b/);

    const timestamps = (await cards.locator('.post-meta small').allTextContents()).map((date) => Date.parse(date));
    expect(timestamps).toHaveLength(cardCount);
    expect(timestamps.every(Number.isFinite)).toBe(true);
    expect(timestamps[0]).toBe(Math.max(...timestamps));

    const search = page.getByRole('searchbox', { name: 'Search articles' });
    await search.fill('diagnostic accuracy');
    await expect(page.locator('.blog-grid > .post-card:visible')).toHaveCount(1);
    await expect(page.locator('.blog-grid > .post-card:visible')).toContainText('Diagnostic Accuracy');

    await search.fill('');
    await expect(page.locator('.blog-grid > .post-card:visible')).toHaveCount(cardCount);
  });

  test('docs and blog post content each use one prose article', async ({ page }) => {
    for (const route of ['/docs/', '/blog/editor-agnostic-dotnet-lsp/']) {
      const response = await page.goto(route);
      expect(response?.status(), `${route} should return 200`).toBe(200);
      await expect(page.locator('article.prose')).toHaveCount(1);
    }
  });

  test('blog articles use a wide frame and readable body measure', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/blog/pull-diagnostics-without-phantom-errors/');

    const dimensions = await page.locator('article.prose').evaluate((article) => {
      const paragraph = article.querySelector(':scope > p');
      const hero = article.querySelector('.article-hero');
      return {
        body: paragraph?.getBoundingClientRect().width ?? 0,
        frame: article.getBoundingClientRect().width,
        hero: hero?.getBoundingClientRect().width ?? 0,
      };
    });

    expect(dimensions.frame).toBeGreaterThanOrEqual(850);
    expect(dimensions.body).toBeGreaterThanOrEqual(700);
    expect(dimensions.body).toBeLessThanOrEqual(740);
    expect(dimensions.hero).toBeGreaterThan(dimensions.body);
  });

  test('mobile docs menu opens the sidebar independently of primary navigation', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/docs/');

    const docsToggle = page.locator('#docs-menu-toggle');
    const docsSidebar = page.locator('#docs-sidebar');
    const primaryToggle = page.locator('#mobile-menu-toggle');
    const primaryMenu = page.locator('#nav-menu');

    await expect(docsToggle).toBeVisible();
    await expect(docsToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(primaryToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(docsSidebar).not.toHaveClass(/\bopen\b/);
    await expect(primaryMenu).not.toHaveClass(/\bopen\b/);

    await docsToggle.click();

    await expect(docsToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(docsSidebar).toHaveClass(/\bopen\b/);
    await expect(primaryToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(primaryMenu).not.toHaveClass(/\bopen\b/);

    await expect.poll(async () => (await docsSidebar.boundingBox())?.x).toBeGreaterThanOrEqual(-1);
    const sidebarBox = await docsSidebar.boundingBox();
    expect(sidebarBox).not.toBeNull();
    expect(sidebarBox.x).toBeLessThan(390);
  });

  test('wide prose tables scroll locally without overflowing the page', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto('/docs/go-to-definition/');

    const table = page.locator('article.prose table').first();
    await expect(table).toBeVisible();

    const tableDimensions = await table.evaluate((element) => ({
      clientWidth: element.clientWidth,
      overflowX: getComputedStyle(element).overflowX,
      scrollWidth: element.scrollWidth,
    }));
    expect(tableDimensions.scrollWidth).toBeGreaterThan(tableDimensions.clientWidth);
    expect(['auto', 'scroll']).toContain(tableDimensions.overflowX);

    const pageDimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    }));
    expect(pageDimensions.scrollWidth).toBeLessThanOrEqual(pageDimensions.clientWidth);
  });
});
