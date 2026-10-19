// Tests for [WEB-DESIGN-MEDIA]: the profiler film and stills the profiler-film
// tooling renders from the real extension.
import { test, expect } from '@playwright/test';
import { expectPlayable, expectStills, playback, sourcesOf } from './media.js';

const FILM_POSTER = '/assets/videos/profiler-film-poster.webp';
const WALKTHROUGH_POSTER = '/assets/videos/profiler-csharp-poster.webp';
const FILM_SOURCES = ['/assets/videos/profiler-film.mp4', '/assets/videos/profiler-film.webm'];
const PROFILER_STILLS = 8;
const DOCS = ['/docs/profiler/', '/zh/docs/profiler/', '/ja/docs/profiler/'];

const FSHARP_POSTER = '/assets/videos/profiler-fsharp-poster.webp';
const FSHARP_STILLS = ['heatmap', 'results', 'leaks', 'graph'].map((shot) => `/assets/screenshots/profiler/profiler-fsharp-${shot}.webp`);
const FSHARP_DOCS = ['/docs/fsharp-profiling/', '/zh/docs/fsharp-profiling/', '/ja/docs/fsharp-profiling/'];

const RECORDING_SOURCES = ['/assets/videos/profiler-cpu-recording.mp4'];
const AUTOPLAYING = ['section.hero video', 'section[aria-labelledby="profiler-title"] video'];

async function expectSilentLoop(request, video, sources) {
  await expect(video).toHaveAttribute('autoplay', '');
  await expect(video).toHaveAttribute('loop', '');
  await expect(video).toHaveAttribute('playsinline', '');
  expect((await playback(video)).muted, 'an autoplaying film must be muted').toBe(true);
  expect(await sourcesOf(video), 'its own files, in preference order').toEqual(sources);
  await expectPlayable(request, sources, 'video/');
}

test.describe('Home page films', () => {
  test('the hero plays the profiler film beside the headline, both encodings served', async ({ page, request }) => {
    await page.goto('/');
    const hero = page.locator('section.hero');
    await expect(hero.getByRole('heading', { level: 1 })).toHaveText('Full C# and F# development. In your editor.');
    const film = hero.locator('video');
    await expectSilentLoop(request, film, FILM_SOURCES);
    await expect(film).toHaveAttribute('poster', FILM_POSTER);
    await expectPlayable(request, [FILM_POSTER], 'image/webp');
  });

  test('the profiler section loops the unedited recording and links to the profiler docs', async ({ page, request }) => {
    await page.goto('/');
    const section = page.locator('section[aria-labelledby="profiler-title"]');
    await expect(section.getByRole('heading', { level: 2 })).toHaveText('Find the hot path. Catch the leak.');
    await expectSilentLoop(request, section.locator('video'), RECORDING_SOURCES);

    await section.getByRole('link', { name: /Explore the profiler/ }).click();
    await expect(page).toHaveURL(/\/docs\/profiler\/$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Profiler');
  });

  test('every film holds still with controls when the reader asks for reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    for (const selector of AUTOPLAYING) {
      const video = page.locator(selector);
      await expect(video).not.toHaveAttribute('autoplay', '');
      expect(await playback(video), `${selector} holds still, and the reader can still start it`).toMatchObject({ paused: true, controls: true });
    }
  });
});

// [WEB-DESIGN-HERO] The hero is one screen: a compact headline beside the film,
// with the whole film above the fold on every desktop screen.
test.describe('Home hero layout', () => {
  for (const [width, height] of [[1280, 720], [1440, 800], [1808, 960], [2560, 1300]]) {
    test(`fills a ${width}x${height} screen with the whole film above the fold`, async ({ page, isMobile }) => {
      test.skip(isMobile, 'the desktop layout');
      await page.setViewportSize({ width, height });
      await page.goto('/');
      const box = (selector) => page.locator(selector).boundingBox();
      const [header, hero, headline, film] = await Promise.all(['.site-header', 'section.hero', '.hero h1', '.hero video'].map(box));
      expect(hero.y, 'the hero starts under the header').toBeCloseTo(header.y + header.height, 0);
      expect(Math.round(hero.y + hero.height), 'the hero fills the screen, no more').toBe(height);
      expect(film.y + film.height, 'the whole film is above the fold').toBeLessThanOrEqual(height);
      expect(film.x, 'the film sits beside the copy').toBeGreaterThan(headline.x + headline.width);
      expect(headline.x, 'the copy and film have equal outer gutters').toBeCloseTo(width - film.x - film.width, 0);
      expect(film.width, 'the film, not the headline, owns the hero').toBeGreaterThan(headline.width * 1.5);
      expect(headline.height, 'the headline stays compact').toBeLessThan(height * 0.3);
    });
  }

  test('stacks the copy above the film on a phone, neither wider than the screen', async ({ page, isMobile }) => {
    test.skip(!isMobile, 'the phone layout');
    await page.goto('/');
    const viewport = page.viewportSize();
    const headline = await page.locator('.hero h1').boundingBox();
    const film = await page.locator('.hero video').boundingBox();
    expect(film.y, 'the film follows the copy').toBeGreaterThan(headline.y + headline.height);
    expect(film.x + film.width).toBeLessThanOrEqual(viewport.width);
    expect(film.x, 'the phone film has equal outer gutters').toBeCloseTo(viewport.width - film.x - film.width, 0);
    expect(headline.x, 'the phone copy has equal outer gutters').toBeCloseTo(viewport.width - headline.x - headline.width, 0);
    expect(headline.height, 'the headline fits in a third of the screen').toBeLessThan(viewport.height / 3);
  });
});

test.describe('Profiler docs media', () => {
  for (const docPath of DOCS) {
    test(`${docPath} shows every profiler still and playable videos with controls`, async ({ page, request }) => {
      await page.goto(docPath);
      const stills = page.locator('img[src^="/assets/screenshots/profiler/"]');
      await expect(stills).toHaveCount(PROFILER_STILLS);
      await expectStills(stills);

      const videos = page.locator('figure video');
      await expect(videos).toHaveCount(3);
      for (const video of await videos.all()) {
        await expect(video).toHaveAttribute('controls', '');
        await expect(video).not.toHaveAttribute('autoplay', '');
        await expectPlayable(request, await sourcesOf(video), 'video/');
      }
      // The page opens on its narrated C# walkthrough; the home page keeps the film.
      await expect(videos.first()).toHaveAttribute('poster', WALKTHROUGH_POSTER);
    });
  }
});

test.describe('F# profiling docs media', () => {
  for (const docPath of FSHARP_DOCS) {
    test(`${docPath} shows the F# stills in order and the F# walkthrough with controls`, async ({ page, request }) => {
      await page.goto(docPath);
      const stills = page.locator('img[src^="/assets/screenshots/profiler/"]');
      await expect(stills).toHaveCount(FSHARP_STILLS.length);
      expect(await stills.evaluateAll((images) => images.map((img) => img.getAttribute('src'))), 'heat map, results, suspects, graph').toEqual(FSHARP_STILLS);
      await expectStills(stills);

      const video = page.locator('figure video');
      await expect(video).toHaveCount(1);
      await expect(video).toHaveAttribute('controls', '');
      await expect(video).not.toHaveAttribute('autoplay', '');
      await expect(video).toHaveAttribute('poster', FSHARP_POSTER);
      await expectPlayable(request, await sourcesOf(video), 'video/');
    });
  }
});
