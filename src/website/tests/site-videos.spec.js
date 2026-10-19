// Tests for [WEB-DESIGN-MEDIA]: every catalogued video woven through the site
// plays from real files, carries a poster, speaks the page's language and is
// described to search engines by a matching schema.org VideoObject.
import { test, expect } from '@playwright/test';
import { expectPlayable, playback, sourcesOf, videoObjects } from './media.js';

const SITE = 'https://sharplsp.dev';
const PROFILER_DOC = ['profiler-film', 'profiler-cpu-recording', 'profiler-memory-timelapse'];
const PROFILER_PAGE = ['profiler-csharp', 'profiler-cpu-recording', 'profiler-memory-timelapse'];
const FSHARP_PAGE = ['fsharp-language', 'profiler-fsharp'];

/** A docs page and its film in every site language; `says` is a word of each language's label. */
const everyLanguage = (page, videos, says) =>
  ['en', 'ja', 'zh'].map((lang) => ({ path: `${lang === 'en' ? '' : `/${lang}`}/docs/${page}`, videos, says: says[lang], lang }));

// Every docs page's narrated walkthrough. [WEB-DESIGN-MEDIA] Placement
const WALKTHROUGHS = [
  ...everyLanguage('', ['getting-started'], { en: 'started', ja: '始める', zh: '开始' }),
  ...everyLanguage('editors/', ['editor-setup'], { en: 'setup', ja: 'エディター設定', zh: '编辑器设置' }),
  ...everyLanguage('configuration/', ['configuration'], { en: 'Configuring', ja: '設定', zh: '配置' }),
  ...everyLanguage('fsharp/', FSHARP_PAGE, { en: 'completion', ja: '補完', zh: '补全' }),
  ...everyLanguage('completions/', ['code-completions'], { en: 'completion', ja: '補完', zh: '补全' }),
  ...everyLanguage('hover/', ['hover'], { en: 'Hover', ja: 'ホバー', zh: '悬停' }),
  ...everyLanguage('go-to-definition/', ['navigation'], { en: 'definition', ja: '定義', zh: '定义' }),
  ...everyLanguage('diagnostics/', ['diagnostics'], { en: 'Diagnostics', ja: '診断', zh: '诊断' }),
  ...everyLanguage('refactoring/', ['refactoring'], { en: 'Refactoring', ja: 'リファクタリング', zh: '重构' }),
  ...everyLanguage('context-menus/', ['context-menus'], { en: 'context', ja: 'コンテキストメニュー', zh: '上下文菜单' }),
  ...everyLanguage('nuget/', ['nuget'], { en: 'NuGet', ja: 'NuGet', zh: 'NuGet' }),
  ...everyLanguage('profiler/', PROFILER_PAGE, { en: 'Profiling', ja: 'プロファイリング', zh: '分析' }),
  ...everyLanguage('memory-leaks/', ['profiler-fix-memory-leak'], { en: 'leak', ja: 'リーク', zh: '泄漏' }),
  ...everyLanguage('fsharp-profiling/', ['profiler-fsharp'], { en: 'profiling', ja: 'プロファイリング', zh: '分析' }),
  ...everyLanguage('architecture/', ['architecture'], { en: 'architecture', ja: 'アーキテクチャ', zh: '架构' }),
  ...everyLanguage('contributing/', ['contributing'], { en: 'Contributing', ja: '貢献', zh: '贡献' }),
];

// `says` is a word only that language's label for the page's first video uses.
const PAGES = [
  { path: '/', videos: ['profiler-film', 'profiler-cpu-recording'], says: 'profiler' },
  ...WALKTHROUGHS,
  { path: '/blog/introducing-sharplsp/', videos: ['profiler-film'], says: 'profiler' },
  { path: '/ja/blog/introducing-sharplsp/', videos: ['profiler-film'], says: 'プロファイラー' },
  { path: '/zh/blog/introducing-sharplsp/', videos: ['profiler-film'], says: '性能分析器' },
  { path: '/blog/editor-agnostic-dotnet-lsp/', videos: ['sharplsp-tour'], says: 'tour' },
  { path: '/ja/blog/editor-agnostic-dotnet-lsp/', videos: ['sharplsp-tour'], says: 'ツアー' },
  { path: '/zh/blog/editor-agnostic-dotnet-lsp/', videos: ['sharplsp-tour'], says: '导览' },
  { path: '/blog/dotnet-profiler-vs-code-csharp-fsharp/', videos: PROFILER_DOC, says: 'profiler' },
  { path: '/ja/blog/dotnet-profiler-vs-code-csharp-fsharp/', videos: PROFILER_DOC, says: 'プロファイラー' },
  { path: '/zh/blog/dotnet-profiler-vs-code-csharp-fsharp/', videos: PROFILER_DOC, says: '性能分析器' },
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
  expect(object.contentUrl, 'search links to the preferred playable encoding').toBe(`${SITE}${sources[0]}`);
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

// Every docs walkthrough is narrated: a reader hears it, and reads it in their own language.
for (const { path, videos, lang } of WALKTHROUGHS) {
  test(`${path} plays ${videos[0]} with its narration, captioned in ${lang} by default`, async ({ page, request }) => {
    await page.goto(path);
    const player = page.locator('figure video').first();
    expect((await playback(player)).muted, 'the narration is heard, never muted').toBe(false);
    const tracks = player.locator('track[kind="captions"]');
    await expect(tracks).toHaveCount(3);
    expect(await tracks.evaluateAll((all) => all.map((track) => track.getAttribute('srclang'))), 'captions in every site language').toEqual(['en', 'ja', 'zh']);
    await expect(player.locator('track[default]')).toHaveAttribute('srclang', lang);
    await expectPlayable(request, await tracks.evaluateAll((all) => all.map((track) => track.getAttribute('src'))), 'text/vtt');
  });
}

test('articles and docs never autoplay; readers start every film themselves', async ({ page }) => {
  const docs = WALKTHROUGHS.filter(({ lang }) => lang === 'en').map(({ path }) => path);
  for (const path of [...docs, '/blog/introducing-sharplsp/', '/blog/editor-agnostic-dotnet-lsp/']) {
    await page.goto(path);
    const player = page.locator('figure video').first();
    await expect(player).toHaveAttribute('controls', '');
    await expect(player).not.toHaveAttribute('autoplay', '');
    expect((await playback(player)).paused, `${path} film waits for the reader`).toBe(true);
  }
});
