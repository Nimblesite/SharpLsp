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

export const sourcesOf = (video) =>
  video.locator('source').evaluateAll((sources) => sources.map((s) => s.getAttribute('src')));

/** Every schema.org VideoObject the page declares, in document order. */
export const videoObjects = (page) =>
  page.locator('script[type="application/ld+json"]').evaluateAll((scripts) =>
    scripts.map((script) => JSON.parse(script.textContent)).filter((data) => data['@type'] === 'VideoObject'),
  );
