// Tests for [WEB-DESIGN-MEDIA-DISCOVERY]: Google indexes a video from a page where
// it is the main content. Every catalogued video has a watch page per language,
// whose metadata matches the real file, a bare embed player, an entry in the
// video sitemap, and crawlers may fetch its files.
import { test, expect } from '@playwright/test';
import { seconds as secondsOf } from '../video-pages.js';
import { LANGS, SITE, VIDEOS, embedOf, expectPlayable, local, videoObjects, watchOf } from './media.js';

const DOC_SLUGS = ['', 'architecture/', 'completions/', 'configuration/', 'context-menus/', 'contributing/', 'diagnostics/',
  'editors/', 'fsharp/', 'fsharp-profiling/', 'go-to-definition/', 'hover/', 'memory-leaks/', 'nuget/', 'profiler/',
  'refactoring/', 'zed/'];

/** The real file's length and frame size, once the browser has read its metadata. */
async function loadedMetadata(video) {
  await video.evaluate((v) => { v.preload = 'auto'; v.load(); });
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 15000 }).toBeGreaterThanOrEqual(1);
  return video.evaluate((v) => ({ duration: v.duration, width: v.videoWidth, height: v.videoHeight }));
}

async function expectWatchPage(page, id, lang) {
  const { label } = VIDEOS[id].text[lang];
  await expect(page.locator('main h1')).toHaveText(label);
  await expect(page).toHaveTitle(label);
  await expect(page.locator('main video')).toHaveCount(1);
  await expect(page.locator('main video')).toHaveAttribute('aria-label', label);
  const [player, heading] = [await page.locator('main video').boundingBox(), await page.locator('main h1').boundingBox()];
  expect(player.y, 'the player is the main content, on the first screen').toBeLessThan(page.viewportSize().height / 2);
  expect(player.y, 'the player leads, the long label follows').toBeLessThan(heading.y);
  expect(await page.locator('meta[property="og:type"]').getAttribute('content')).toBe('video.other');
  expect(await page.locator('meta[property="video:duration"]').getAttribute('content')).toBe(String(secondsOf(VIDEOS[id].duration)));
  await expect(page.locator(`figcaption a[href="${watchOf(id, lang)}"]`), 'a watch page never links to itself').toHaveCount(0);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `${SITE}${watchOf(id, lang)}`);
}

async function expectWatchStructuredData(page, id, lang) {
  const [described] = await videoObjects(page);
  expect(described.name).toBe(VIDEOS[id].text[lang].label);
  expect(described.embedUrl).toBe(`${SITE}${watchOf(id, lang)}embed/`);
  expect(described.contentUrl).toBe(`${SITE}/assets/videos/${id}.mp4`);
  expect(described.potentialAction['@type']).toBe('SeekToAction');
  expect(described.potentialAction.target).toBe(`${SITE}${watchOf(id, lang)}?t={seek_to_second_number}`);
  expect(described.potentialAction['startOffset-input']).toBe('required name=seek_to_second_number');
  expect(Boolean(described.transcript), 'a narrated film carries its transcript').toBe((VIDEOS[id].captions ?? []).includes(lang));
  const [webPage] = await page.locator('script[type="application/ld+json"]').evaluateAll((scripts) =>
    scripts.flatMap((script) => JSON.parse(script.textContent)['@graph'] ?? []).filter((node) => node['@type'] === 'WebPage'));
  expect(webPage.datePublished, 'the page is published when its video was').toBe(uploadedAt(id));
}

/** When video `id` was uploaded, as the ISO timestamp pages and the sitemap carry. */
const uploadedAt = (id) => new Date(VIDEOS[id].uploadDate).toISOString();

/** The narration as text: one paragraph per spoken cue, no sound cues. */
async function expectTranscript(page, id, lang) {
  const lines = page.locator('main section p');
  if (!(VIDEOS[id].captions ?? []).includes(lang)) return expect(lines).toHaveCount(0);
  expect(await lines.count(), `${id} transcript has its narration`).toBeGreaterThan(0);
  expect((await lines.allTextContents()).some((line) => line.startsWith('[')), 'sound cues are not speech').toBe(false);
  const [described] = await videoObjects(page);
  expect(described.transcript).toBe((await lines.allTextContents()).join(' '));
}

for (const id of Object.keys(VIDEOS)) {
  test(`${id} has a watch page in every language, described as its real file`, async ({ page, request }) => {
    for (const lang of LANGS) {
      await page.goto(watchOf(id, lang));
      await expectWatchPage(page, id, lang);
      await expectWatchStructuredData(page, id, lang);
      await expectTranscript(page, id, lang);
      const guide = page.locator('main p > a').last();
      await expect(guide).toHaveAttribute('href', local(lang, VIDEOS[id].page));
      expect((await request.get(local(lang, VIDEOS[id].page))).status(), 'the guide link resolves').toBe(200);
    }
    const real = await loadedMetadata(page.locator('main video'));
    expect({ width: real.width, height: real.height }, 'the catalogue has the real frame size').toEqual({ width: VIDEOS[id].width, height: VIDEOS[id].height });
    // The catalogue holds whole seconds; browsers differ by milliseconds on where a file ends.
    expect(Math.abs(real.duration - secondsOf(VIDEOS[id].duration)), 'the catalogue has the real length').toBeLessThan(1);
  });
}

test('docs figures link to their watch page, which opens at ?t= seconds', async ({ page }) => {
  await page.goto('/docs/hover/');
  const link = page.locator('figure figcaption a[href="/videos/hover/"]');
  await expect(link).toHaveCount(1);
  await link.click();
  await expect(page).toHaveURL(/\/videos\/hover\/$/);
  await page.goto('/videos/hover/?t=30');
  const video = page.locator('main video');
  await expect.poll(() => video.evaluate((v) => Math.floor(v.currentTime)), { timeout: 15000 }).toBe(30);
  await expect(video).toHaveJSProperty('paused', true);
  await page.goto('/ja/videos/hover/');
  expect(await page.locator('main video').evaluate((v) => v.currentTime)).toBe(0);
});

for (const lang of LANGS) {
  test(`every ${lang} embed page is the bare player, kept out of the index`, async ({ page, request }) => {
    for (const id of Object.keys(VIDEOS)) {
      await page.goto(embedOf(id, lang));
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', 'noindex');
      await expect(page.locator('header, nav, footer, h1')).toHaveCount(0);
      const player = page.locator('body > video');
      await expect(player).toHaveAttribute('aria-label', VIDEOS[id].text[lang].label);
      await expect(player.locator('source').first()).toHaveAttribute('src', `/assets/videos/${id}.mp4`);
      const box = await player.boundingBox();
      expect(box.width, 'the player fills the frame').toBe(page.viewportSize().width);
    }
    await expectPlayable(request, [`${watchOf('hover', lang)}embed/`], 'text/html');
  });
}

/** Each sitemap `<url>` as its location and its video entry's fields, parsed by the browser. */
const sitemapEntries = (page, xml) =>
  page.evaluate((text) => {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const field = (node, name) => node.getElementsByTagName(`video:${name}`)[0]?.textContent ?? null;
    return [...doc.getElementsByTagName('url')].map((url) => ({
      loc: url.getElementsByTagName('loc')[0].textContent,
      lastmod: url.getElementsByTagName('lastmod')[0]?.textContent ?? null,
      videos: url.getElementsByTagName('video:video').length,
      ...Object.fromEntries(['title', 'description', 'thumbnail_loc', 'content_loc', 'player_loc', 'duration', 'publication_date']
        .map((name) => [name, field(url, name)])),
    }));
  }, xml);

function expectVideoEntry(entry, id, lang) {
  const { label, caption } = VIDEOS[id].text[lang];
  expect(entry, `${id} (${lang}) has one video entry`).toMatchObject({ videos: 1, title: label, description: caption });
  expect(entry.thumbnail_loc).toBe(`${SITE}/assets/videos/${id}-poster.webp`);
  expect(entry.content_loc).toBe(`${SITE}/assets/videos/${id}.mp4`);
  expect(entry.player_loc).toBe(`${SITE}${watchOf(id, lang)}embed/`);
  expect(Number(entry.duration)).toBe(secondsOf(VIDEOS[id].duration));
  expect(entry.publication_date).toBe(VIDEOS[id].uploadDate);
  expect(entry.lastmod, 'a watch page changes when its video does, not with each build').toBe(uploadedAt(id));
}

test('the sitemap lists every docs page and every watch page with its video', async ({ page, request }) => {
  const response = await request.get('/sitemap.xml');
  expect(response.status()).toBe(200);
  const byLoc = new Map((await sitemapEntries(page, await response.text())).map((entry) => [entry.loc, entry]));
  for (const lang of LANGS) {
    for (const slug of DOC_SLUGS) expect(byLoc.has(`${SITE}${local(lang, `/docs/${slug}`)}`), `docs/${slug} (${lang})`).toBe(true);
    for (const id of Object.keys(VIDEOS)) expectVideoEntry(byLoc.get(`${SITE}${watchOf(id, lang)}`), id, lang);
  }
  expect([...byLoc.keys()].some((loc) => loc.endsWith('/embed/')), 'embed pages stay out').toBe(false);
  const served = Object.keys(VIDEOS).flatMap((id) => [`/assets/videos/${id}-poster.webp`, `/assets/videos/${id}.mp4`]);
  await expectPlayable(request, served.filter((url) => url.endsWith('.webp')), 'image/webp');
  await expectPlayable(request, served.filter((url) => url.endsWith('.mp4')), 'video/mp4');
});

test('robots.txt lets every crawler fetch the media and points at the sitemap', async ({ request }) => {
  const robots = await (await request.get('/robots.txt')).text();
  const everyone = robots.split(/\n\s*\n/).find((group) => /^User-agent: \*$/m.test(group));
  expect(everyone, 'a group for every crawler').toBeTruthy();
  expect(everyone).toMatch(/^Allow: \/$/m);
  expect(everyone, 'nothing under /assets/ is blocked').not.toMatch(/^Disallow: \/(assets)?\/?$/m);
  expect(robots).toContain(`Sitemap: ${SITE}/sitemap.xml`);
});
