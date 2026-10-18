# Profiler films

This folder holds the scripts that shoot and publish the videos and stills on sharplsp.dev. Every frame is the real extension: an isolated VS Code (its own user data and extensions, never yours) runs the packaged VSIX against a demo app. Nothing in the editor is mocked. The rules are in [WEB-DESIGN-MEDIA](../../../../docs/specs/DESIGN-SYSTEM.md).

## Make a film

You need a packaged VSIX, ffmpeg with libvpx and libopus, cwebp, and the .NET 10 SDK. Install the narration voice once:

```sh
npm ci --prefix src/website                            # Playwright
npm ci --prefix src/website/tools/profiler-film        # kokoro-js, for narration
```

The first narrated publish downloads the voice model (about 310 MB) into `node_modules`; a later `npm ci` there deletes it again.

Then shoot and publish a film by its name in `films/`:

```sh
make _film FILM=fsharp             # package the VSIX, shoot, then publish
make _film FILM=fsharp PUBLISH=1   # publish the last shoot again
```

`make _film` runs `node src/website/tools/profiler-film/film.mjs <film> [--publish]`, which you can also call directly after `make _build-vsix VSIX_PREBUILT=1`.

A shoot takes a few minutes and lands in `out/<film>/`, which is gitignored. Publishing writes the MP4, WebM, poster, captions and stills into `src/website/src/assets/`. Add or update the video's entry in `src/website/src/_data/videos.json` (its length, its upload date, and its label and caption in each language), then place it on a page with `{% video "<name>" %}`.

| Film | Video | Docs page |
|---|---|---|
| `getting-started` | `getting-started` | Getting Started |
| `editor-setup` | `editor-setup` | Editor Setup |
| `configuration` | `configuration` | Configuration |
| `fsharp-language` | `fsharp-language` | F# Language Support |
| `completions` | `code-completions` | Code Completions |
| `hover` | `hover` | Hover and Quick Info |
| `navigation` | `navigation` | Go to Definition |
| `diagnostics` | `diagnostics` | Diagnostics |
| `refactoring` | `refactoring` | Refactoring & Code Actions |
| `context-menus` | `context-menus` | Context Menus |
| `nuget` | `nuget` | NuGet Package Manager |
| `csharp` | `profiler-csharp` | Profiler |
| `fsharp` | `profiler-fsharp` | Profiling F# (and the F# page) |
| `leak` | `profiler-fix-memory-leak` | Fix a Memory Leak |
| `architecture` | `architecture` | Architecture |
| `contributing` | `contributing` | Contributing |
| `films/profiler/` | `profiler-film` | The home page: the one-minute composited film (`capture.mjs`, then `render.mjs`) |
| `doc-stills` | (stills only) | Each feature page's still and the launch post's figures, in `screenshots/docs/` |

Every film but `films/profiler/` is narrated. The Zed page has none: Zed is a native application, and filming it would mean recording the real desktop.

## Add a film

A film is one file in `films/`. It exports the video's name, the demo it is shot on, the poster frame and its scenes, and optionally the workspace `settings` it is shot with (the profiler's by default):

```js
import { LANGUAGE, hoverEach, prepareCode, scene } from '../kit/acts/language.mjs';
import { SHOP } from '../kit/set.mjs';

export default {
  name: 'hover',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'hover.narration.json', // optional
  poster: { scene: 'fsharp', at: 4 },
  scenes: [
    { offCamera: prepareCode('Program.fs', { line: 9, word: 'generate' }) },
    scene('fsharp', 1, 'F#: the inferred signature, with your doc comment', ({ page }) => hoverEach(page, [{ line: 9, word: 'generate' }])),
  ],
};
```

A scene is either a clip or a step off camera:

- `{ clip, act, speed, retries }`: `act(shot)` is recorded in real time as `<clip>.mp4`. It plays back at `speed`, and the frame shows a speed badge whenever `speed` is above 1. `retries` shoots a failed take again. `scene(clip, step, caption, act, { speed, retries })` builds one with its numbered caption.
- `{ offCamera }`: `offCamera(shot)` runs between clips and is never recorded. Use it for setup, rebuilds and stills.

A film may also take stills (`snap(shot, name)`), published as `screenshots/<stillsFolder>/<name>.webp` (`profiler` unless the film names another folder). A film with no clips, like `doc-stills`, publishes only its stills.

`shot` is `{ page, set, app, workspace, stills }`: the Playwright page, the recorder, the demo process, the staged workspace and the stills folder.

The kit tells the common stories, so a film only supplies its words:

| Module | What it gives a film |
|---|---|
| `kit/acts/cpu.mjs` | `cpuLoop(story, first)`: Profile CPU, sampling at 4×, the heat map, the results panel, and optional stills |
| `kit/acts/memory.mjs` | `memoryLoop(story, first)`: Track Memory, growth at 8×, a suspect, the retention graph, the fix typed in, and the fixed build tracked again |
| `kit/acts/tour.mjs` | `profilerTour(cpu, memory)`: both loops on one demo, as the C# and F# profiler films tell them |
| `kit/acts/language.mjs` | The language films' `LANGUAGE` settings, `prepareCode` and `warm` (wait until an engine answers a hover), `scene`, and the editor's own moves: `complete`, `quickFix`, `renameTo`, `navigate`, `peekReferences`, `hoverEach`, `settingsEditor` |
| `kit/acts/shop.mjs` | Moves on the Shop demo several films share: code typed through completion in F# and C#, a generated match case, a rename across files |
| `kit/acts/explorer.mjs` | The Solution Explorer: `openMenu` on a row, `pickMenu`, `unfold` |
| `kit/code.mjs` | `wordOn`, `findWord`, `hoverOn` and `clickOn`: a word on a line of the editor, found on screen |
| `kit/scenes.mjs` | `prepare(file)`, `switchTo(file)`, `restart`, `startOnRow(step, text, action, status)`, and the shoot and publish engine |
| `kit/overlay.mjs` | `caption(page, step, text, speed)`, `pointAt(page, at)` (the pointer glides to what a film acts on) and `ringClick(page, cues, locator, label)` |
| `kit/workbench.mjs` | Editor moves: the Processes view and its demo row, `openFile`, `goTo`, `typeAt`, `toggleMaximised`, `panel` and more |
| `kit/camera.mjs` | `snap(shot, name)` takes a still, published as `<name>.webp` |
| `kit/set.mjs` | The sets (`STOREFRONT`, `FS_STOREFRONT`, `SHOP` with both in one solution, and `REPO`, a clean copy of this repository) and `onSet`, which stages one beside an isolated editor |
| `kit/sound/` | Narration (`voice.mjs`), the original score (`score.mjs`) and the mix (`soundtrack.mjs`) |

A new demo app goes in `demos/<folder>/`, with one project and an empty `Directory.Build.props`, and is declared in `kit/set.mjs`. It must print a line to stdout once it is running.

**Nothing personal reaches a frame.** The demo is staged under `/tmp`. The editor runs on a copy-on-write clone of the .NET install at `/tmp/sharplsp-film-dotnet` (made once, sharing the original's blocks) with its login-shell environment off, so the SDK path the extension reports and the commands its terminals print are neutral. A failed shoot leaves `out/<film>/failure.png` and the editor's logs in `out/<film>/logs`.

## Narration

A narrated film has a script next to it, `films/<film>.narration.json`:

```json
{
  "voice": "af_heart",
  "say": { "F#": "F sharp" },
  "music": { "en": "[Gentle music]", "ja": "[穏やかな音楽]", "zh": "[舒缓的音乐]" },
  "lines": [{ "scene": "heat", "en": "…", "ja": "…", "zh": "…" }]
}
```

- **Voice.** Kokoro-82M (Apache-2.0) speaks each line in English on this machine, through `kokoro-js`. Never use a speech service or the operating system's voices: their licences forbid publishing.
- **Pronunciation.** `say` respells words for the voice only. The captions keep the original spelling.
- **Timing.** Each line starts just after its scene's cut. A scene holds its last frame until its line has been spoken, so keep lines about as long as their scenes.
- **Music.** `kit/sound/score.mjs` synthesises an original score, so no film carries licensed music. It ducks under the voice, and the mix is normalised to -16 LUFS.
- **Captions.** Every language in `music` gets WebVTT captions, `<name>.<lang>.vtt`. List those languages under `captions` in `videos.json`, and the page's own language shows by default.
