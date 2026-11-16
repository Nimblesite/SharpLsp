// Implements [WEB-DESIGN-MEDIA-DISCOVERY] for the C#/F# debugging lesson.
import { test, expect } from '@playwright/test';

for (const prefix of ['', '/ja', '/zh']) {
  test(`${prefix}/docs/debugging/ exposes the lesson and readable controls`, async ({ page }) => {
    await page.goto(`${prefix}/docs/debugging/`);
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('#docs-sidebar a[aria-current="page"]')).toHaveAttribute('href', `${prefix}/docs/debugging/`);
    const video = page.locator('article video');
    // Captions ship in every site language; the page's own language is the default track.
    const lang = prefix.slice(1) || 'en';
    await expect(video.locator('track[kind="captions"]')).toHaveCount(3);
    await expect(video.locator('track[kind="captions"][default]')).toHaveAttribute('src', `/assets/videos/debugging.${lang}.vtt`);
    await expect(video.locator('track[kind="captions"][default]')).toHaveAttribute('srclang', lang);
    await expect(video.locator('track[kind="chapters"]')).toHaveCount(1);
    expect(await video.evaluate(async (element) => {
      const image = new Image();
      image.src = element.poster;
      await image.decode();
      return image.naturalWidth;
    })).toBe(1920);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
