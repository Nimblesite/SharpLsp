# Videos

Every video and still on sharplsp.dev is made here. A film is a folder in `films/`, and one command makes it:

```sh
node src/website/tools/video/film.mjs <film>
```

Every frame shows the real extension. An isolated VS Code, with its own user data and extensions and never yours, runs the packaged VSIX against a real .NET demo app. Nothing in the editor is mocked. The rules are in [WEB-DESIGN-MEDIA](../../../../docs/specs/DESIGN-SYSTEM.md).

## Layout

```text
video/
  film.mjs                one entry point: shoot, publish or preview any film by its folder name
  films/<film>/           one folder per film: film.mjs, plus narration.json when it is narrated
  kit/                    all shared code. A film holds only its own words, timings and edits
    acts/                 stories several films tell (the CPU and memory loops, language moves, the Shop demo)
    lesson/               the lesson deck (deck.html, deck.js) and its pipeline (lesson.mjs)
    sound/                voice, the two scores, and the mix
  templates/walkthrough/  copy this to start a walkthrough
  templates/lesson/       copy this to start a lesson
  demos/                  the .NET apps films are shot on
  heroes/                 blog hero images, as HTML pages
  out/<film>/             each film's shoot and render working files (gitignored)
```

The rule: if two films could share a piece of code, it lives in `kit/`.

## Kinds of film

What a film's `film.mjs` exports decides its kind. `film.mjs` runs each kind the same way:

| Kind | Exports | How it is made | Example |
|---|---|---|---|
| Walkthrough | `scenes` | Scenes are shot as real-time clips, cut through the [camera](#camera), then narrated | `hover`, `blazor` |
| Stills | `scenes` with no clips | The same shoot, but it publishes only stills | `doc-stills` |
| Lesson | `lesson` | Slides around footage cut from published walkthroughs. Nothing is shot | `refactoring-lesson` |
| Composite | `shoot`, `publish`, `preview` | The film shoots its own footage and renders its own page over it | `profiler` |

## Commands

```sh
make _build-vsix VSIX_PREBUILT=1                                # the VSIX every shoot installs
node src/website/tools/video/film.mjs <film>                    # shoot, then publish
node src/website/tools/video/film.mjs <film> --publish          # publish the last shoot again
node src/website/tools/video/film.mjs <film> --preview 2,20,60  # stills at those seconds (lessons, composites)
make _film FILM=<film> [PUBLISH=1]                              # packages the VSIX, then runs the above
```

You need ffmpeg (with libvpx and libopus), cwebp and the .NET 10 SDK. Install the node dependencies once:

```sh
npm ci --prefix src/website               # Playwright
npm ci --prefix src/website/tools/video   # kokoro-js, the narration voice
```

The first narrated publish downloads the voice model (about 310 MB) into `node_modules`. Running `npm ci` there again deletes it.

## From shoot to page

1. **Shoot.** The demo is copied to `/tmp`, built and opened. Each clip is recorded into `out/<film>/clips/`, with its camera track beside it.
2. **Publish.** Clips are cut through the camera, voiced and scored. The output goes to `src/website/src/assets/`:
   - `videos/<name>.mp4` and `videos/<name>.webm`
   - `videos/<name>-poster.webp`
   - `videos/<name>.<lang>.vtt`
   - `screenshots/<folder>/*.webp`
3. **Catalogue.** Add or update the video in `src/website/src/_data/videos.json`: its length, upload date, and label and caption in each language.
4. **Place.** Put `{% video "<name>" %}` on a page.

A failed shoot leaves `out/<film>/failure.png` and the editor's logs in `out/<film>/logs/`.

## Films

| Film | Kind | Video | Page |
|---|---|---|---|
| `getting-started` | walkthrough | `getting-started` | Getting Started |
| `editor-setup` | walkthrough | `editor-setup` | Editor Setup |
| `configuration` | walkthrough | `configuration` | Configuration |
| `fsharp-language` | walkthrough | `fsharp-language` | F# Language Support |
| `completions` | walkthrough | `code-completions` | Code Completions |
| `hover` | walkthrough | `hover` | Hover and Quick Info |
| `navigation` | walkthrough | `navigation` | Go to Definition |
| `diagnostics` | walkthrough | `diagnostics` | Diagnostics |
| `refactoring` | walkthrough | `refactoring` | Refactoring & Code Actions |
| `refactoring-lesson` | lesson | `refactoring-lesson` | Refactoring & Code Actions |
| `context-menus` | walkthrough | `context-menus` | Context Menus |
| `nuget` | walkthrough | `nuget` | NuGet Package Manager |
| `blazor` | walkthrough | `blazor` | Blazor |
| `csharp` | walkthrough | `profiler-csharp` | Profiler |
| `fsharp` | walkthrough | `profiler-fsharp` | Profiling F# |
| `leak` | walkthrough | `profiler-fix-memory-leak` | Fix a Memory Leak |
| `architecture` | walkthrough | `architecture` | Architecture |
| `contributing` | walkthrough | `contributing` | Contributing |
| `profiler` | composite | `profiler-film`, `profiler-cpu-recording`, `profiler-memory-timelapse` | Home page, Profiler |
| `doc-stills` | stills | (each feature page's still) | Every docs page, the launch post |

Every film except `profiler` and `doc-stills` is narrated. Zed has no film: it is a native app, and filming it would mean recording the real desktop.

## Make a walkthrough

```sh
cp -R src/website/tools/video/templates/walkthrough src/website/tools/video/films/<name>
```

The finished reference is `films/blazor/`. `film.mjs` exports:

- `name`: the video's name.
- `demo`: the set it is shot on, from `kit/set.mjs`.
- `settings`: workspace settings. `LANGUAGE` from `kit/acts/language.mjs` for language films; otherwise the profiler's.
- `narration`: the script file beside it.
- `poster: { scene, at }`: the poster frame.
- `scenes`: each scene is one of two kinds:
  - `scene(clip, step, caption, act, { speed, retries })` records `act(shot)` in real time as `<clip>.mp4`, with a numbered step caption.
    - `speed` fast-forwards playback and shows a speed badge.
    - `retries` shoots a failed take again.
  - `{ offCamera: (shot) => … }` runs between clips and is never recorded. Use it for setup, rebuilds and stills.

`shot` is `{ page, set, app, workspace, stills }`: the Playwright page, the recorder, the demo process, the staged workspace and the stills folder. `snap(shot, name)` takes a still, published as `screenshots/<stillsFolder>/<name>.webp`. The folder is `profiler` unless the film names another.

Show F# before C#. A scene never moves the camera itself. It puts the pointer and the text cursor on what it shows (`hoverOn`, `clickOn`, `typeAt`) and holds while the viewer reads.

## Make a lesson

```sh
cp -R src/website/tools/video/templates/lesson src/website/tools/video/films/<name>
node src/website/tools/video/film.mjs <name> --preview 2,20,60   # stills, timed from word counts, no speech
node src/website/tools/video/film.mjs <name>                     # speak, render and publish
```

A lesson teaches one feature end to end. The reference is `films/refactoring-lesson/`.

- **Slides.** `film.mjs` exports `lesson: { series, slides }`. Each slide has an `id` and a `layout`: `title`, `keys`, `points`, `footage`, `code`, `cards`, `flow` or `recap`. `kit/lesson/deck.js` draws them, and the template uses each layout once.
- **Lines.** A line's `scene` in `narration.json` is its slide's `id`. A slide holds until its lines are spoken, and an item with `line: n` appears as the slide's n-th line starts.
- **Footage.** A `footage` slide cuts a published walkthrough. It sets:
  - `video`: the walkthrough.
  - `from`, `to`: the seconds to cut.
  - `crop`: a part of the 1920×1200 frame that leaves out the step caption.
  - `speed`: for a fast-forwarded stretch, so the speed badge stays on screen.
- **Pace.** Lessons are quick: the af_bella voice at 1.12×, tight `pacing`, and the `drive` score.

Catalogue the lesson in `videos.json` before the walkthrough it cuts from, and lead its docs page with it. Expand the page into the same lesson: what you will learn, numbered steps with code to try, what happens underneath, and a recap.

## Camera

Every walkthrough clip is framed by one camera, `kit/zoom.mjs`, so no film keys a shot by hand ([WEB-DESIGN-MEDIA-CAMERA](../../../../docs/specs/DESIGN-SYSTEM.md)). While a clip records, `kit/track.mjs` samples 20 times a second:

- where the pointer and the text cursor are;
- every widget open beside them: a hover, the completion list, a peek, the rename box, a menu, or the Problems panel.

Publishing reads that track:

- **Push in.** The camera opens wide, then pushes in at most 2× on whichever of the pointer and the text cursor moved last, with everything open beside it. It frames a gliding pointer where the pointer stops.
- **Look ahead.** Each framing also covers the next 1.5 seconds of action, so typing doesn't drag the camera along.
- **Ease.** Each move takes 0.8 seconds and starts 0.35 seconds before the action it frames.
- **Pull back.** When nothing is open for 2 seconds, and the quiet lasts at least 2.5 seconds more, the camera pulls back out.
- **Stay sharp.** Frames are cropped from 3200×2000 footage, so the deepest zoom stays crisp. Step captions and speed badges (`kit/captions.mjs`) are laid over the cut after the camera, so they never move.

Tune the camera in `CAMERA`. A shoot from before tracks existed has none, so shoot it again.

## Narration

```json
{
  "voice": "af_heart",
  "say": { "F#": "F sharp" },
  "music": { "en": "[Gentle music]", "ja": "[穏やかな音楽]", "zh": "[舒缓的音乐]" },
  "lines": [{ "scene": "fsharp", "en": "…", "ja": "…", "zh": "…" }]
}
```

- **Voice.** Kokoro-82M (Apache-2.0) speaks the English lines locally through `kokoro-js`. Never use a speech service or the operating system's voices: their licences forbid publishing.
- **Pronunciation.** `say` respells words for the voice only. Captions keep the original spelling.
- **Timing.** Each line starts just after its scene's cut. A scene holds its last frame until its line is spoken, so keep each line about as long as its scene.
- **Pace.** `speed` speeds up the voice, and `pacing` sets the gaps (`kit/sound/voice.mjs` has the defaults).
- **Music.** `score` picks an original score synthesised in code, so no film carries licensed music:
  - `calm` (`kit/sound/score.mjs`), the default for walkthroughs.
  - `drive` (`kit/sound/drive.mjs`, 124 BPM), for lessons.

  The score ducks under the voice, and the mix is normalised to -16 LUFS.
- **Captions.** Every language under `music` gets `<name>.<lang>.vtt`. List those languages under `captions` in `videos.json`.

## Sets

A set is a demo from `demos/`, declared in `kit/set.mjs`. `onSet` stages it beside an isolated editor:

| Set | Demo | Used by |
|---|---|---|
| `STOREFRONT` | `demos/storefront`: a C# app that checks out orders forever, with hot paths and a cache that never evicts | the profiler films |
| `FS_STOREFRONT` | `demos/fs-storefront`: its F# twin | the F# profiler film |
| `SHOP` | `demos/Shop.slnx`: both storefronts in one solution, nothing running | the language films |
| `BLAZOR_STOREFRONT` | `demos/blazor-storefront`: a Blazor Web App | `blazor` |
| `REPO` | a clean copy of this repository, without the extension | `configuration`, `contributing` |

To add a demo, put one project and an empty `Directory.Build.props` in `demos/<folder>/`, and declare it in `kit/set.mjs`. A demo that runs must print a line to stdout once it has started. A set must hold exactly one solution, or SharpLsp may load the wrong one.

**Nothing personal reaches a frame.**

- The demo is staged under `/tmp`.
- The editor runs on a copy-on-write clone of the .NET install at `/tmp/sharplsp-film-dotnet`, with its login-shell environment off. The SDK path the extension reports, and the commands its terminals print, are neutral.
- The in-app tutorial is switched off, so it never opens on camera.

## Kit

| Module | What it gives a film |
|---|---|
| `kit/scenes.mjs` | The walkthrough engine: `shootWalkthrough`, `publishWalkthrough`, and the scene helpers `prepare`, `switchTo`, `restart`, `startOnRow` |
| `kit/lesson/` | The lesson engine: `deck.js` draws each layout from `t` alone, and `lesson.mjs` cuts the footage, times slides to speech and renders them |
| `kit/frames.mjs` | Renders a page whose `renderFrame(t)` draws each frame: `renderMaster`, `previewFrames`, and `explode` (footage into numbered frames). Lessons and the profiler film use it |
| `kit/set.mjs` | The sets, and `onSet` |
| `kit/editor.mjs` | The isolated VS Code, and the settings every shot is filmed with |
| `kit/camera.mjs` | `record` shoots a clip with its track. `snap` and `still` take stills |
| `kit/track.mjs`, `kit/zoom.mjs` | The [camera](#camera): what it follows, and how it frames |
| `kit/captions.mjs`, `kit/overlay.mjs` | Step captions and speed badges. `pointAt` glides the pointer, and `ringClick` marks a click |
| `kit/code.mjs` | Finds a word on an editor line on screen: `wordOn`, `findWord`, `hoverOn`, `clickOn` |
| `kit/workbench.mjs` | Editor moves: `openFile`, `goTo`, `typeAt`, the Processes view, panels |
| `kit/acts/language.mjs` | The language films' `LANGUAGE` settings, plus `prepareCode`, `scene`, `complete`, `quickFix`, `renameTo`, `navigate`, `peekReferences`, `hoverEach`, `settingsEditor` |
| `kit/acts/shop.mjs` | Moves on the Shop demo: typing through completion in F# and C#, a generated match case, a rename across files |
| `kit/acts/cpu.mjs`, `kit/acts/memory.mjs`, `kit/acts/tour.mjs` | The profiler stories: `cpuLoop`, `memoryLoop`, and `profilerTour`, which runs both on one demo |
| `kit/acts/explorer.mjs` | The Solution Explorer: `openMenu`, `pickMenu`, `unfold` |
| `kit/publish.mjs` | `narrated` and `publishEncodes`: the one route from a film's picture to the site's MP4 and WebM, with voice, score and captions |
| `kit/encode.mjs` | The H.264 and VP9 settings, posters, stills, and the `out/` and asset paths |
| `kit/sound/` | `voice.mjs` (narration), `score.mjs` and `drive.mjs` (the scores), `soundtrack.mjs` (the mix) |

## Heroes

`heroes/` holds blog hero images as HTML pages, one per post, each sized to the hero (1672×941). Screenshot the page at that size, and save the image where the post's `image:` front matter points.
