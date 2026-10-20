// Tests for [WEB-DESIGN-MEDIA-DISCOVERY]: every catalogued video has a watch page
// Google can index it from, a bare embed player, a video sitemap entry and
// structured data that match the real files, and every docs page shares its film
// as a playable social preview.
import { test, expect } from '@playwright/test';
import { LANGS, SITE, VIDEOS, embedOf, expectPlayable, local } from './media.js';

const cardOf = (id) => `/assets/videos/${id}-card.jpg`;
const mp4Of = (id) => `/assets/videos/${id}.mp4`;

// Each docs page's preview is the film it leads with. [WEB-DESIGN-MEDIA-DISCOVERY] Social previews
const PREVIEWS = {
  '/docs/': 'getting-started', '/docs/editors/': 'editor-setup', '/docs/configuration/': 'configuration',
  '/docs/fsharp/': 'fsharp-language', '/docs/blazor/': 'blazor', '/docs/completions/': 'code-completions', '/docs/hover/': 'hover',
  '/docs/go-to-definition/': 'navigation', '/docs/diagnostics/': 'diagnostics', '/docs/refactoring/': 'refactoring-lesson',
  '/docs/context-menus/': 'context-menus', '/docs/nuget/': 'nuget', '/docs/profiler/': 'profiler-csharp',
  '/docs/memory-leaks/': 'profiler-fix-memory-leak', '/docs/fsharp-profiling/': 'profiler-fsharp',
  '/docs/architecture/': 'architecture', '/docs/contributing/': 'contributing',
};
const DOCS = [...Object.keys(PREVIEWS), '/docs/zed/'];

const meta = (page, key) => page.locator(`meta[property="${key}"], meta[name="${key}"]`).getAttribute('content');

/** The decoded size of the image at `src`, as a browser sees it. */
const imageSize = (page, src) =>
  page.evaluate(async (url) => {
    const image = new Image();
    image.src = url;
    await image.decode();
    return [image.naturalWidth, image.naturalHeight];
  }, src);

async function expectFilmPreview(page, request, id, lang) {
  expect(await meta(page, 'og:image')).toBe(`${SITE}${cardOf(id)}`);
  expect(await meta(page, 'twitter:image')).toBe(`${SITE}${cardOf(id)}`);
  expect(await imageSize(page, cardOf(id)), 'the card is the 1200x630 social size').toEqual([1200, 630]);
  expect(await meta(page, 'og:image:alt')).toBe(VIDEOS[id].text[lang].label);
  expect(await meta(page, 'og:video')).toBe(`${SITE}${mp4Of(id)}`);
  expect(await meta(page, 'og:video:type')).toBe('video/mp4');
  expect(await meta(page, 'og:video:width')).toBe(String(VIDEOS[id].width));
  expect(await meta(page, 'twitter:card')).toBe('player');
  expect(await meta(page, 'twitter:player')).toBe(`${SITE}${embedOf(id, lang)}`);
  expect(await meta(page, 'twitter:player:stream')).toBe(`${SITE}${mp4Of(id)}`);
  await expectPlayable(request, [cardOf(id)], 'image/jpeg');
  await expectPlayable(request, [mp4Of(id)], 'video/mp4');
}

for (const [path, id] of Object.entries(PREVIEWS)) {
  test(`${path} shares ${id} as a playable social preview in every language`, async ({ page, request }) => {
    for (const lang of LANGS) {
      await page.goto(local(lang, path));
      await expectFilmPreview(page, request, id, lang);
      expect(await page.locator('figure video').first().getAttribute('aria-label'), 'the preview is the film the page leads with')
        .toBe(VIDEOS[id].text[lang].label);
      await expect(page).toHaveTitle(/ \| SharpLsp$/);
    }
  });
}

test('a page without a film shares the site card, described, as a large image', async ({ page, request }) => {
  for (const path of ['/docs/zed/', '/ja/docs/zed/', '/']) {
    await page.goto(path);
    expect(await meta(page, 'og:image')).toBe(`${SITE}/assets/images/og-image.png`);
    expect(await meta(page, 'twitter:card')).toBe('summary_large_image');
    expect((await meta(page, 'og:image:alt')).length, 'the site card has alt text').toBeGreaterThan(20);
    await expect(page.locator('meta[property="og:video"]')).toHaveCount(0);
  }
  await expectPlayable(request, ['/assets/images/og-image.png'], 'image/png');
});

for (const lang of LANGS) {
  test(`every ${lang} docs page has its own description`, async ({ page }) => {
    await page.goto(local(lang, '/'));
    const homeDescription = await meta(page, 'description');
    const descriptions = [];
    for (const path of DOCS) {
      await page.goto(local(lang, path));
      descriptions.push(await meta(page, 'og:description'));
      expect(await meta(page, 'description')).toBe(descriptions.at(-1));
    }
    expect(descriptions, 'no docs page borrows the home page description').not.toContain(homeDescription);
    expect(new Set(descriptions).size, 'every description is unique').toBe(DOCS.length);
  });
}
