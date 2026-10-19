// Shared probes for [WEB-DESIGN-MEDIA] tests: is a media URL really served, and
// what does a page tell search engines about its videos?
import { expect } from '@playwright/test';

/** Fetch the first bytes of a media URL; returns its status and content type. */
async function probe(request, url) {
  const response = await request.get(url, { headers: { Range: 'bytes=0-1023' } });
  return { status: response.status(), type: response.headers()['content-type'] ?? '' };
}

export async function expectPlayable(request, urls, kind) {
  for (const url of urls) {
    const { status, type } = await probe(request, url);
    expect([200, 206], `${url} must be served`).toContain(status);
    expect(type, `${url} must be served as ${kind}`).toContain(kind);
  }
}

/** What the player is doing right now, as the reader would see it. */
export const playback = (video) =>
  video.evaluate((element) => ({ paused: element.paused, controls: element.controls, muted: element.muted }));

/** Real decoding, including errors raised AFTER play() resolves. [WEB-DESIGN-MEDIA] */
export async function expectFramesAdvance(video, from) {
  const frames = await video.evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames);
  await expect.poll(() => video.evaluate((v, start) => ({
    error: v.error?.message ?? null,
    paused: v.paused,
    advancing: v.currentTime > start.time + 1,
    decoding: v.getVideoPlaybackQuality().totalVideoFrames > start.frames + 5,
  }), { time: from, frames }), { timeout: 15000 }).toEqual({
    error: null, paused: false, advancing: true, decoding: true,
  });
}

export const sourcesOf = (video) =>
  video.locator('source').evaluateAll((sources) => sources.map((s) => s.getAttribute('src')));

/** Every schema.org VideoObject the page declares, in document order. */
export const videoObjects = (page) =>
  page.locator('script[type="application/ld+json"]').evaluateAll((scripts) =>
    scripts.map((script) => JSON.parse(script.textContent)).filter((data) => data['@type'] === 'VideoObject'),
  );

const STILL_WIDTH = 2400;

/** Every still in `stills` loads as the 2400px render with real alt text. [WEB-DESIGN-MEDIA] */
export async function expectStills(stills) {
  for (const still of await stills.all()) {
    await still.scrollIntoViewIfNeeded();
    const rendered = await still.evaluate((img) => ({ complete: img.complete, width: img.naturalWidth, alt: img.alt }));
    expect(rendered.complete, 'still finishes loading').toBe(true);
    expect(rendered.width, 'still is the 2400px render').toBe(STILL_WIDTH);
    // Characters, not words: a CJK description is dense, so the floor is low but real.
    expect(rendered.alt.length, 'still has meaningful alt text').toBeGreaterThanOrEqual(8);
    expect(rendered.alt, 'alt text describes the shot, not the file').not.toContain('.webp');
  }
}
