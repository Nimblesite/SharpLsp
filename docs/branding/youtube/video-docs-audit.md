# Video documentation audit

Audited 2026-11-14 on `fix/563-progressive-load`.

- All 26 catalogued videos are embedded in English, Japanese and Chinese documentation.
- All 47 catalogued MP4/WebM encodings passed a complete FFmpeg decode. MP4 dimensions match the catalogue. No website MP4 is outside the catalogue.
- Debugging, C# 14 and Move Type MP4 files match the rendered deliveries in Videos byte-for-byte.
- Added the profiler overview and workspace tour to docs, corrected their guide destinations, and added Japanese and Chinese captions to the three newest tutorials.

The debugging guide is `src/website/src/docs/debugging.md`; its video is `src/website/src/assets/videos/debugging.mp4`. Its localized guides are under `src/website/src/ja/docs/` and `src/website/src/zh/docs/`.

## Production revision

The live `deployment-sha.txt` probe returned `92a333e21e14289d5d25ff235dfc4319523dc00c`. The live `/docs/debugging/` probe returned HTTP 503. The current branch contains newer docs changes. The deployment workflow publishes on release or manual dispatch.

## Catalogue coverage

Paths below are the English guides. The same embeds were checked under `/ja` and `/zh` on desktop and phone.

| Video | Documentation | Encodings decoded | Duration (seconds) |
| --- | --- | --- | --- |
| profiler-film | /docs/profiler/ | 2 | 64.467 |
| profiler-csharp | /docs/profiler/ | 2 | 136.385 |
| profiler-cpu-recording | /docs/profiler/ | 1 | 18.067 |
| profiler-memory-timelapse | /docs/profiler/ | 1 | 16.033 |
| profiler-fix-memory-leak | /docs/memory-leaks/ | 2 | 92.324 |
| profiler-fsharp | /docs/fsharp-profiling/ | 2 | 111.5 |
| sharplsp-tour | /docs/editors/ | 2 | 22.0 |
| vscode-tutorial | /docs/tutorial/ | 2 | 228.594 |
| getting-started | /docs/ | 2 | 64.894 |
| editor-setup | /docs/editors/ | 2 | 41.1 |
| configuration | /docs/configuration/ | 2 | 50.54 |
| fsharp-language | /docs/fsharp/ | 2 | 115.209 |
| blazor | /docs/blazor/ | 2 | 158.367 |
| code-completions | /docs/completions/ | 2 | 72.867 |
| hover | /docs/hover/ | 2 | 76.819 |
| navigation | /docs/go-to-definition/ | 2 | 61.324 |
| diagnostics | /docs/diagnostics/ | 2 | 83.9 |
| refactoring-lesson | /docs/refactoring/ | 2 | 228.894 |
| refactoring | /docs/refactoring/ | 2 | 87.183 |
| context-menus | /docs/context-menus/ | 2 | 69.667 |
| nuget | /docs/nuget/ | 2 | 78.1 |
| architecture | /docs/architecture/ | 2 | 37.6 |
| contributing | /docs/contributing/ | 2 | 37.815 |
| debugging | /docs/debugging/ | 1 | 105.626 |
| csharp-14 | /docs/csharp-14/ | 1 | 88.118 |
| move-type | /docs/refactoring/ | 1 | 91.397 |

## Regression checks

`tests/video-docs-audit.spec.js` walks the complete catalogue in every site language, checking each doc embed, player controls, media encodings, posters and captions. It runs on desktop Chromium and iPhone SE. `tests/site-videos.spec.js` checks placement, narration, default captions and structured data for the changed guides. The website build passed. Deslop remained at 22 groups.

Final browser run passed all 66 checks across desktop Chromium and iPhone SE. The six new caption files preserve their English source cue timings.
