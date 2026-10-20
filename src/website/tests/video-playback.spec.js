// Regression for [WEB-DESIGN-MEDIA]: a served file and a resolved play()
// promise do not prove playback. Windows Chrome/Edge decoded one WebM frame,
// then paused with PIPELINE_ERROR_DECODE. Exercise the real media pipeline.
import { test, expect } from '@playwright/test';
import { expectFramesAdvance } from './media.js';

const FILMS = [
  ['/docs/fsharp/', 0], ['/docs/fsharp-profiling/', 0], ['/docs/blazor/', 0],
  ['/docs/', 0], ['/docs/editors/', 0], ['/docs/configuration/', 0],
  ['/docs/completions/', 0], ['/docs/hover/', 0], ['/docs/go-to-definition/', 0],
  ['/docs/diagnostics/', 0], ['/docs/refactoring/', 0], ['/docs/context-menus/', 0],
  ['/docs/nuget/', 0], ['/docs/profiler/', 0], ['/docs/profiler/', 1],
  ['/docs/profiler/', 2], ['/docs/memory-leaks/', 0],
  ['/docs/architecture/', 0], ['/docs/contributing/', 0],
  ['/blog/introducing-sharplsp/', 0], ['/blog/editor-agnostic-dotnet-lsp/', 0],
  ['/blog/blazor-razor-vs-code/', 0],
];

for (const [route, index] of FILMS) {
  test(`${route} video ${index} decodes, pauses, seeks and resumes`, async ({ page }) => {
    await page.goto(route);
    const video = page.locator('figure video').nth(index);
    await video.scrollIntoViewIfNeeded();
    await video.evaluate((v) => v.play());
    await expectFramesAdvance(video, 0);
    await video.evaluate((v) => v.pause());
    await expect(video).toHaveJSProperty('paused', true);
    const stopped = await video.evaluate((v) => v.currentTime);
    await page.waitForTimeout(250);
    await expect(video).toHaveJSProperty('currentTime', stopped);
    const seek = await video.evaluate((v) => { v.currentTime = v.duration / 2; return v.currentTime; });
    await video.evaluate((v) => v.play());
    await expectFramesAdvance(video, seek);
  });
}
