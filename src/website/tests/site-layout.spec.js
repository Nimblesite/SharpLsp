// End-to-end coverage for [WEB-DESIGN-LAYOUT], [WEB-DESIGN-RESPONSIVE], and [WEB-DESIGN-ACCESSIBILITY].
import { test, expect } from '@playwright/test';

const HOMEPAGE_WIDTHS = [320, 360, 390, 768, 1440];
const LOCALIZED_ROUTES = [
  '',
  'releases/',
  'author/christian-findlay/',
  'author/sharplsp-team/',
  'blog/',
  'blog/tags/',
  'blog/categories/',
  'blog/editor-agnostic-dotnet-lsp/',
  'blog/introducing-sharplsp/',
  'blog/pull-diagnostics-without-phantom-errors/',
  'blog/why-fsharp-is-first-class-in-sharplsp/',
  'docs/',
  'docs/architecture/',
  'docs/completions/',
  'docs/configuration/',
  'docs/context-menus/',
  'docs/contributing/',
  'docs/diagnostics/',
  'docs/editors/',
  'docs/fsharp/',
  'docs/go-to-definition/',
  'docs/hover/',
  'docs/nuget/',
  'docs/profiler/',
  'docs/refactoring/',
];

async function mainContentShape(page) {
  return page.locator('main').evaluate((main) => {
    const selectors = ['h1', 'h2', 'h3', 'h4', 'p', 'li', 'table', 'tbody tr', 'pre', 'blockquote', 'img', 'a'];
    const authoredCount = (selector) => [...main.querySelectorAll(selector)].filter((element) => {
      const diagram = element.closest('.mermaid');
      return diagram === null || diagram === element;
    }).length;
    return Object.fromEntries(selectors.map((selector) => [selector, authoredCount(selector)]));
  });
}

async function mainInternalLinks(page) {
  return page.locator('main a[href^="/"]').evaluateAll((links) => links.map((link) => link.getAttribute('href')));
}

function isProseRoute(route) {
  const blogIndexes = new Set(['blog/', 'blog/categories/', 'blog/tags/']);
  return route.startsWith('docs/') || route.startsWith('author/') || (route.startsWith('blog/') && !blogIndexes.has(route));
}

async function expectValidJsonLd(page, path) {
  const documents = await page.locator('script[type="application/ld+json"]').allTextContents();
  expect(documents.length, `${path} should expose structured data`).toBeGreaterThan(0);
  for (const document of documents) expect(() => JSON.parse(document), `${path} JSON-LD should parse`).not.toThrow();
}

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

    await search.fill('no article could possibly match this');
    await expect(page.locator('.blog-grid > .post-card:visible')).toHaveCount(0);
    await expect(page.locator('#blog-search-empty')).toBeVisible();
    await expect(page.locator('#blog-search-empty')).toHaveText('No articles match your search.');

    await search.fill('');
    await expect(page.locator('.blog-grid > .post-card:visible')).toHaveCount(cardCount);
    await expect(page.locator('#blog-search-empty')).toBeHidden();
  });

  test('docs and blog post content each use one prose article', async ({ page }) => {
    for (const route of ['/docs/', '/blog/editor-agnostic-dotnet-lsp/']) {
      const response = await page.goto(route);
      expect(response?.status(), `${route} should return 200`).toBe(200);
      await expect(page.locator('article.prose')).toHaveCount(1);
    }
  });

  test('every authored page exists in Japanese and Chinese with the same content structure', async ({ page }) => {
    test.setTimeout(120_000);
    const internalLinks = new Set();
    const localeLinkMismatches = [];
    const shapeMismatches = [];
    const localizedRoots = new Set(['author', 'blog', 'docs', 'releases']);

    for (const route of LOCALIZED_ROUTES) {
      const englishPath = `/${route}`;
      const englishResponse = await page.goto(englishPath);
      expect(englishResponse?.status(), `${englishPath} should return 200`).toBe(200);
      await expectValidJsonLd(page, englishPath);
      if (isProseRoute(route)) {
        await expect(page.locator('article.prose')).toHaveCount(1);
      }
      (await mainInternalLinks(page)).forEach((href) => internalLinks.add(href));
      const englishShape = route === 'releases/' ? null : await mainContentShape(page);

      for (const locale of ['ja', 'zh']) {
        const localizedPath = `/${locale}/${route}`;
        const response = await page.goto(localizedPath);
        expect(response?.status(), `${localizedPath} should return 200`).toBe(200);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expectValidJsonLd(page, localizedPath);
        if (isProseRoute(route)) {
          await expect(page.locator('article.prose')).toHaveCount(1);
        }
        const localizedLinks = await mainInternalLinks(page);
        localizedLinks.forEach((href) => {
          internalLinks.add(href);
          const [firstSegment] = new URL(href, page.url()).pathname.split('/').filter(Boolean);
          if (localizedRoots.has(firstSegment)) localeLinkMismatches.push({ path: localizedPath, href });
        });
        if (englishShape) {
          const localizedShape = await mainContentShape(page);
          if (JSON.stringify(localizedShape) !== JSON.stringify(englishShape)) {
            shapeMismatches.push({ path: localizedPath, expected: englishShape, received: localizedShape });
          }
        }
      }
    }

    expect(localeLinkMismatches, 'localized content links must retain the current locale').toEqual([]);
    expect(shapeMismatches, 'localized pages must preserve the English content structure').toEqual([]);
    for (const href of internalLinks) {
      const response = await page.request.get(href);
      expect(response.status(), `${href} should not be a broken internal link`).toBeLessThan(400);
    }
  });

  test('team attribution links Christian Findlay in every language', async ({ page }) => {
    for (const locale of ['', 'ja/', 'zh/']) {
      await page.goto(`/${locale}author/sharplsp-team/`);
      await expect(page.locator('article.prose a[href="https://www.christianfindlay.com/"]')).toHaveCount(1);
    }
  });

  test('localized taxonomy pages retain their language and translated chrome', async ({ page }) => {
    const expected = {
      ja: { allCategories: 'すべてのカテゴリー', allTags: 'すべてのタグ', architecture: 'アーキテクチャ', skip: 'メインコンテンツへ移動' },
      zh: { allCategories: '所有分类', allTags: '所有标签', architecture: '架构', skip: '跳到主要内容' },
    };

    for (const [locale, text] of Object.entries(expected)) {
      for (const [route, heading, back] of [
        ['blog/tags/dotnet-lsp/', '.NET LSP', text.allTags],
        ['blog/categories/architecture/', text.architecture, text.allCategories],
      ]) {
        const response = await page.goto(`/${locale}/${route}`);
        expect(response?.status()).toBe(200);
        await expect(page.locator('html')).toHaveAttribute('lang', locale);
        await expect(page.locator('.blog-header h1')).toHaveText(heading);
        await expect(page.locator('.blog-subtitle')).toContainText(back);
        await expect(page.locator('.skip-link')).toHaveText(text.skip);
        for (const targetLocale of ['en', 'ja', 'zh']) {
          const targetPath = targetLocale === 'en' ? `/${route}` : `/${targetLocale}/${route}`;
          await expect(page.locator(`.language-dropdown a[lang="${targetLocale}"]`)).toHaveAttribute('href', targetPath);
        }
      }
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

    await page.keyboard.press('Escape');
    await expect(docsToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(docsSidebar).not.toHaveClass(/\bopen\b/);
    await expect(primaryToggle).toHaveAttribute('aria-expanded', 'false');
    await expect(primaryMenu).not.toHaveClass(/\bopen\b/);
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
    expect(tableDimensions.scrollWidth).toBeGreaterThanOrEqual(tableDimensions.clientWidth);
    expect(['auto', 'scroll']).toContain(tableDimensions.overflowX);

    const pageDimensions = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
    }));
    expect(pageDimensions.scrollWidth).toBeLessThanOrEqual(pageDimensions.clientWidth);
  });
});
