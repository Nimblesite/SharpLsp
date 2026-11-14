// Implements [WEB-DESIGN-MEDIA-DISCOVERY] for every catalogue entry, including new films.
import { test, expect } from '@playwright/test';
import { VIDEOS, LANGS, local, expectPlayable } from './media.js';

for (const lang of LANGS) {
  test(`all catalogued videos are embedded in ${lang} docs with served assets`, async ({ page, request }) => {
    for (const [id, film] of Object.entries(VIDEOS)) {
      expect(film.page, `${id} must point to its documentation`).toMatch(/^\/docs\//);
      await page.goto(local(lang, film.page));
      const player = page.locator(`article video:has(source[src="/assets/videos/${id}.${film.encodings[0]}"])`);
      await expect(player, `${id} must be embedded in ${lang} docs`).toHaveCount(1);
      await expect(player).toHaveAttribute('controls', '');
      await expect(player).toHaveAttribute('poster', `/assets/videos/${id}-poster.webp`);
      for (const encoding of film.encodings) {
        await expectPlayable(request, [`/assets/videos/${id}.${encoding}`], `video/${encoding}`);
      }
      await expectPlayable(request, [`/assets/videos/${id}-poster.webp`], 'image/webp');
      for (const caption of film.captions ?? []) {
        await expect(player.locator(`track[kind="captions"][srclang="${caption}"]`)).toHaveCount(1);
        expect((await request.get(`/assets/videos/${id}.${caption}.vtt`)).ok()).toBe(true);
      }
    }
  });
}
