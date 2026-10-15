// Tests for [WEB-DESIGN-MEDIA]: the profiler film and stills the profiler-film
// tooling renders from the real extension.
import { test, expect } from '@playwright/test';

const FILM_POSTER = '/assets/videos/profiler-film-poster.webp';
const FILM_SOURCES = ['/assets/videos/profiler-film.webm', '/assets/videos/profiler-film.mp4'];
const PROFILER_STILLS = 8;
const STILL_WIDTH = 2400;
const DOCS = ['/docs/profiler/', '/zh/docs/profiler/', '/ja/docs/profiler/'];

/** Fetch the first bytes of a media URL; returns its status and content type. */
async function probe(request, url) {
  const response = await request.get(url, { headers: { Range: 'bytes=0-1023' } });
  return { status: response.status(), type: response.headers()['content-type'] ?? '' };
}

async function expectPlayable(request, urls, kind) {
  for (const url of urls) {
    const { status, type } = await probe(request, url);
    expect([200, 206], `${url} must be served`).toContain(status);
    expect(type, `${url} must be served as ${kind}`).toContain(kind);
  }
}

const sourcesOf = (video) => video.locator('source').evaluateAll((sources) => sources.map((s) => s.getAttribute('src')));

test.describe('Home page profiler film', () => {
  test('autoplays muted on a loop, serves both encodings and links to the profiler docs', async ({ page, request }) => {
    await page.goto('/');
    const section = page.locator('section[aria-labelledby="profiler-title"]');
    await expect(section.getByRole('heading', { level: 2 })).toHaveText('Find the hot path. Catch the leak.');
    const video = section.locator('video');
    await expect(video).toHaveAttribute('autoplay', '');
    await expect(video).toHaveAttribute('loop', '');
    await expect(video).toHaveAttribute('playsinline', '');
    await expect(video).toHaveAttribute('poster', FILM_POSTER);
    expect(await video.evaluate((element) => element.muted), 'an autoplaying film must be muted').toBe(true);
    expect(await sourcesOf(video), 'WebM first, MP4 fallback').toEqual(FILM_SOURCES);
    await expectPlayable(request, FILM_SOURCES, 'video/');
    await expectPlayable(request, [FILM_POSTER], 'image/webp');

    await section.getByRole('link', { name: /Explore the profiler/ }).click();
    await expect(page).toHaveURL(/\/docs\/profiler\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Profiler');
  });

  test('holds still with controls when the reader asks for reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    const video = page.locator('section[aria-labelledby="profiler-title"] video');
    await expect(video).not.toHaveAttribute('autoplay', '');
    expect(await video.evaluate((element) => element.paused), 'the film must not play').toBe(true);
    expect(await video.evaluate((element) => element.controls), 'the reader can still start it').toBe(true);
  });
});

test.describe('Profiler docs media', () => {
  for (const docPath of DOCS) {
    test(`${docPath} shows every profiler still and playable videos with controls`, async ({ page, request }) => {
      await page.goto(docPath);
      const stills = page.locator('img[src^="/assets/screenshots/profiler/"]');
      await expect(stills).toHaveCount(PROFILER_STILLS);
      for (const still of await stills.all()) {
        await still.scrollIntoViewIfNeeded();
        const rendered = await still.evaluate((img) => ({ complete: img.complete, width: img.naturalWidth, alt: img.alt }));
        expect(rendered.complete, 'still finishes loading').toBe(true);
        expect(rendered.width, 'still is the 2400px render').toBe(STILL_WIDTH);
        // Characters, not words: a CJK description is dense, so the floor is low but real.
        expect(rendered.alt.length, 'still has meaningful alt text').toBeGreaterThanOrEqual(8);
        expect(rendered.alt, 'alt text describes the shot, not the file').not.toContain('.webp');
      }

      const videos = page.locator('figure video');
      await expect(videos).toHaveCount(3);
      for (const video of await videos.all()) {
        await expect(video).toHaveAttribute('controls', '');
        await expect(video).not.toHaveAttribute('autoplay', '');
        await expectPlayable(request, await sourcesOf(video), 'video/');
      }
      await expect(videos.first()).toHaveAttribute('poster', FILM_POSTER);
    });
  }
});
