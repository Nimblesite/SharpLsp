// Tests for [WEB-DESIGN-MEDIA]: every catalogued video woven through the site
// plays from real files, carries a poster, speaks the page's language and is
// described to search engines by a matching schema.org VideoObject.
import { test, expect } from '@playwright/test';
import { expectPlayable, playback, sourcesOf, videoObjects } from './media.js';

const SITE = 'https://sharplsp.dev';
const PROFILER_DOC = ['profiler-film', 'profiler-cpu-recording', 'profiler-memory-timelapse'];

// `says` is a word only that language's label for the page's first video uses.
const PAGES = [
  { path: '/', videos: ['profiler-film', 'profiler-cpu-recording'], says: 'profiler' },
  { path: '/docs/', videos: ['sharplsp-tour'], says: 'tour' },
  { path: '/ja/docs/', videos: ['sharplsp-tour'], says: 'ツアー' },
  { path: '/zh/docs/', videos: ['sharplsp-tour'], says: '导览' },
  { path: '/docs/profiler/', videos: PROFILER_DOC, says: 'profiler' },
  { path: '/ja/docs/profiler/', videos: PROFILER_DOC, says: 'プロファイラー' },
  { path: '/zh/docs/profiler/', videos: PROFILER_DOC, says: '性能分析器' },
  { path: '/docs/memory-leaks/', videos: ['profiler-fix-memory-leak'], says: 'leak' },
  { path: '/ja/docs/memory-leaks/', videos: ['profiler-fix-memory-leak'], says: 'リーク' },
  { path: '/zh/docs/memory-leaks/', videos: ['profiler-fix-memory-leak'], says: '泄漏' },
  { path: '/blog/introducing-sharplsp/', videos: ['profiler-film'], says: 'profiler' },
  { path: '/ja/blog/introducing-sharplsp/', videos: ['profiler-film'], says: 'プロファイラー' },
  { path: '/zh/blog/introducing-sharplsp/', videos: ['profiler-film'], says: '性能分析器' },
  { path: '/blog/editor-agnostic-dotnet-lsp/', videos: ['sharplsp-tour'], says: 'tour' },
  { path: '/ja/blog/editor-agnostic-dotnet-lsp/', videos: ['sharplsp-tour'], says: 'ツアー' },
  { path: '/zh/blog/editor-agnostic-dotnet-lsp/', videos: ['sharplsp-tour'], says: '导览' },
  { path: '/blog/dotnet-profiler-memory-leak-search-trends/', videos: PROFILER_DOC, says: 'profiler' },
  { path: '/ja/blog/dotnet-profiler-memory-leak-search-trends/', videos: PROFILER_DOC, says: 'プロファイラー' },
  { path: '/zh/blog/dotnet-profiler-memory-leak-search-trends/', videos: PROFILER_DOC, says: '性能分析器' },
  { path: '/blog/how-to-fix-a-memory-leak-in-csharp-dotnet/', videos: ['profiler-fix-memory-leak'], says: 'leak' },
  { path: '/ja/blog/how-to-fix-a-memory-leak-in-csharp-dotnet/', videos: ['profiler-fix-memory-leak'], says: 'リーク' },
  { path: '/zh/blog/how-to-fix-a-memory-leak-in-csharp-dotnet/', videos: ['profiler-fix-memory-leak'], says: '泄漏' },
];

const poster = (id) => `/assets/videos/${id}-poster.webp`;

async function expectServedWithPoster(request, player, id) {
  await expect(player).toHaveAttribute('poster', poster(id));
  await expect(player).toHaveAttribute('playsinline', '');
  const sources = await sourcesOf(player);
  expect(sources.length, `${id} has an encoding`).toBeGreaterThan(0);
  expect(sources.every((src) => src.startsWith(`/assets/videos/${id}.`)), `${id} plays its own files`).toBe(true);
  await expectPlayable(request, sources, 'video/');
  await expectPlayable(request, [poster(id)], 'image/webp');
  return sources;
}

function expectDescribed(object, id, label, sources) {
  expect(object.name, 'search sees the same title the reader hears').toBe(label);
  expect(object.description.length, 'a real description').toBeGreaterThanOrEqual(20);
  expect(object.thumbnailUrl).toBe(`${SITE}${poster(id)}`);
  expect(object.contentUrl).toBe(`${SITE}${sources.at(-1)}`);
  expect(object.duration).toMatch(/^PT(\d+M)?\d+S$/);
  expect(Number.isNaN(Date.parse(object.uploadDate)), 'uploadDate is a real date').toBe(false);
}

for (const { path, videos, says } of PAGES) {
  test(`${path} plays ${videos.join(', ')} and describes each for search`, async ({ page, request }) => {
    await page.goto(path);
    const players = page.locator('figure video');
    await expect(players).toHaveCount(videos.length);
    const described = await videoObjects(page);
    expect(described, 'one VideoObject per video, in order').toHaveLength(videos.length);
    expect(await players.first().getAttribute('aria-label')).toContain(says);

    for (const [index, id] of videos.entries()) {
      const player = players.nth(index);
      const sources = await expectServedWithPoster(request, player, id);
      const caption = player.locator('xpath=following-sibling::figcaption');
      await expect(caption).not.toBeEmpty();
      expectDescribed(described[index], id, await player.getAttribute('aria-label'), sources);
    }
  });
}

test('articles and docs never autoplay; readers start every film themselves', async ({ page }) => {
  for (const path of ['/docs/', '/docs/memory-leaks/', '/blog/introducing-sharplsp/', '/blog/editor-agnostic-dotnet-lsp/']) {
    await page.goto(path);
    const player = page.locator('figure video').first();
    await expect(player).toHaveAttribute('controls', '');
    await expect(player).not.toHaveAttribute('autoplay', '');
    expect((await playback(player)).paused, `${path} film waits for the reader`).toBe(true);
  }
});
