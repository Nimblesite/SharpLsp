# Videos

Every video and still on sharplsp.dev is made here, on one shared kit: the walkthroughs, the composited profiler film, the lessons and the blog heroes. Every frame is the real extension: an isolated VS Code (its own user data and extensions, never yours) runs the packaged VSIX against a demo app. Nothing in the editor is mocked. The rules are in [WEB-DESIGN-MEDIA](../../../../docs/specs/DESIGN-SYSTEM.md).

## Layout

```text
video/
  film.mjs              one entry point: shoot, publish or preview any film by name
  kit/                  the shared code every film is made with (see the table below)
    lesson/             the lesson deck: slides drawn frame by frame (deck.html, deck.js, lesson.mjs)
    sound/              voice, scores and mix
    acts/               stories several walkthroughs tell
  films/<name>/         one folder per film: film.mjs, and narration.json when it is narrated
  films/profiler/       the composited home-page film (capture.mjs, then render.mjs)
  templates/walkthrough/  the starting point for a new walkthrough, cut through the camera
  templates/lesson/     the starting point for a new lesson
  demos/                the .NET apps the walkthroughs are shot on
  heroes/               the blog posts' hero images, as HTML pages
  out/<name>/           every shoot's and render's working files (gitignored)
```

A film's own words, timings and edits live only in its folder; everything two films could share lives in `kit/`.

## Make a film

You need a packaged VSIX, ffmpeg with libvpx and libopus, cwebp, and the .NET 10 SDK. Install the narration voice once:

```sh
npm ci --prefix src/website                            # Playwright
npm ci --prefix src/website/tools/video        # kokoro-js, for narration
```

The first narrated publish downloads the voice model (about 310 MB) into `node_modules`; a later `npm ci` there deletes it again.

Then shoot and publish a film by the name of its folder in `films/`:

```sh
make _film FILM=fsharp             # package the VSIX, shoot, then publish
make _film FILM=fsharp PUBLISH=1   # publish the last shoot again
```

`make _film` runs `node src/website/tools/video/film.mjs <film> [--publish]`, which you can also call directly after `make _build-vsix VSIX_PREBUILT=1`.

A shoot takes a few minutes and lands in `out/<film>/`, which is gitignored: each clip, and beside it the track its camera follows. Publishing frames every clip through the camera (see [Camera](#camera)), writing each clip's crop script and caption frames into `out/<film>/camera/`, then writes the MP4, WebM, poster, captions and stills into `src/website/src/assets/`. Add or update the video's entry in `src/website/src/_data/videos.json` (its length, its upload date, and its label and caption in each language), then place it on a page with `{% video "<name>" %}`.

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
| `refactoring` | `refactoring` | Refactoring & Code Actions (the one-take walkthrough) |
| `refactoring-lesson` | `refactoring-lesson` | Refactoring & Code Actions (the lesson, see [Make a lesson](#make-a-lesson)) |
| `context-menus` | `context-menus` | Context Menus |
| `nuget` | `nuget` | NuGet Package Manager |
| `csharp` | `profiler-csharp` | Profiler |
| `fsharp` | `profiler-fsharp` | Profiling F# (and the F# page) |
| `leak` | `profiler-fix-memory-leak` | Fix a Memory Leak |
| `architecture` | `architecture` | Architecture |
| `contributing` | `contributing` | Contributing |
| `films/profiler/` | `profiler-film` | The home page: the one-minute composited film (`capture.mjs`, then `render.mjs`) |
| `doc-stills` | (stills only) | Each feature page's still and the launch post's figures, in `screenshots/docs/` |

Every film but `films/profiler/` and `doc-stills` is narrated. The Zed page has none: Zed is a native application, and filming it would mean recording the real desktop.

## Add a film

A walkthrough is a folder, `films/<name>/`, whose `film.mjs` exports the video's name, the demo it is shot on, the poster frame and its scenes, and optionally the workspace `settings` it is shot with (the profiler's by default):

```js
import { LANGUAGE, hoverEach, prepareCode, scene } from '../../kit/acts/language.mjs';
import { SHOP } from '../../kit/set.mjs';

export default {
  name: 'hover',
  demo: SHOP,
  settings: LANGUAGE,
  narration: 'narration.json', // optional, beside film.mjs
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
| `kit/overlay.mjs` | `caption(page, step, text, speed)` (logs the step caption, drawn over the cut after the camera), `pointAt(page, at)` (the pointer glides to what a film acts on) and `ringClick(page, cues, locator, label)` |
| `kit/track.mjs` | What the camera follows: the pointer, the text cursor and the editor's open widgets, sampled while a clip records |
| `kit/zoom.mjs` | The camera: `writeCamera(track, clip)` frames a clip from its track, tuned in `CAMERA` |
| `kit/captions.mjs` | `captionFrames`: the step captions and speed badges, rendered once each as transparent frames for the cut |
| `kit/workbench.mjs` | Editor moves: the Processes view and its demo row, `openFile`, `goTo`, `typeAt`, `toggleMaximised`, `panel` and more |
| `kit/camera.mjs` | `record` shoots a clip with its track; `snap(shot, name)` takes a still, published as `<name>.webp` |
| `kit/set.mjs` | The sets (`STOREFRONT`, `FS_STOREFRONT`, `SHOP` with both in one solution, and `REPO`, a clean copy of this repository) and `onSet`, which stages one beside an isolated editor |
| `kit/publish.mjs` | `narrated` and `publishEncodes`: the one way a film's picture becomes the site's MP4 and WebM, with its voice, score and captions |
| `kit/lesson/` | The lesson deck: `deck.js` draws each slide layout from `t` alone, and `lesson.mjs` cuts the footage, times the slides to the speech and renders them |
| `kit/frames.mjs` | `explode` (footage into numbered frames) and `renderMaster` / `previewFrames`: step a page whose `renderFrame(t)` draws every frame, into a lossless master. The profiler film and the lessons render through it |
| `kit/sound/` | Narration (`voice.mjs`), the original scores (`score.mjs`, calm, for walkthroughs; `drive.mjs`, quick, for lessons) and the mix (`soundtrack.mjs`) |

A new demo app goes in `demos/<folder>/`, with one project and an empty `Directory.Build.props`, and is declared in `kit/set.mjs`. It must print a line to stdout once it is running.

**Nothing personal reaches a frame.** The demo is staged under `/tmp`. The editor runs on a copy-on-write clone of the .NET install at `/tmp/sharplsp-film-dotnet` (made once, sharing the original's blocks) with its login-shell environment off, so the SDK path the extension reports and the commands its terminals print are neutral. A failed shoot leaves `out/<film>/failure.png` and the editor's logs in `out/<film>/logs`.

## Camera

Every walkthrough is cut through one camera, `kit/zoom.mjs`, so no film keys a shot by hand ([WEB-DESIGN-MEDIA-CAMERA](../../../../docs/specs/DESIGN-SYSTEM.md)). While a clip records, `kit/track.mjs` samples where the pointer and the text cursor are, and every widget the editor has open beside them (a hover, the completion list, a peek, the rename box, a menu, the Problems panel), twenty times a second, and logs each step caption. The shoot saves the track beside the clip as `<clip>.track.json`. Publishing reads it:

- **Push in.** A clip opens wide, then pushes in on the pointer or the text cursor, whichever moved last, with everything the editor has open beside it, at most 2×. A pointer gliding across the editor is framed where it comes to rest, not along its way.
- **Look ahead.** A framing covers the next 1.5 seconds of action too, so typing does not drag the camera along. The camera holds while the action stays in frame and moves when it leaves.
- **Ease.** Each move takes 0.8 seconds, starting 0.35 seconds before the action it frames. A fast-forwarded clip's moves are paced to look the same on screen.
- **Pull back.** Two quiet seconds with nothing open pull the camera back out, when the quiet lasts at least 2.5 seconds longer.
- **Stay sharp.** Each frame is cropped from the 3200×2000 footage, so the deepest zoom stays crisp. The step caption and speed badge (`kit/captions.mjs`) are laid over the cut after the camera, so they never move and are never cropped.

Tune the camera in `CAMERA`. A shoot from before tracks existed has none: shoot it again.

## Make a lesson

A lesson teaches one feature end to end, as a narrated slide film around real footage. Its footage is cut from the feature's published walkthrough, so a lesson never shows a mocked editor. The reference lesson is `films/refactoring-lesson/`; start every new one from the template:

```sh
cp -R src/website/tools/video/templates/lesson src/website/tools/video/films/<name>
node src/website/tools/video/film.mjs <name> --preview 2,20,60   # stills, timed from word counts, no speech
node src/website/tools/video/film.mjs <name>                     # speak, render and publish
```

- `film.mjs` exports `lesson: { series, slides }` instead of `scenes`. Each slide has an `id` and a `layout`: `title`, `keys`, `points`, `footage`, `code`, `cards`, `flow` or `recap` (`kit/lesson/deck.js` draws them; the template uses each once).
- `narration.json` holds the lines. A line's `scene` is its slide's `id`; a slide holds until its lines are spoken, and an item with `line: n` appears as the slide's n-th line starts.
- A `footage` slide names a published walkthrough (`video`), the seconds to cut (`from`, `to`), a `crop` of its 1920x1200 frame that leaves out the walkthrough's step caption, and `speed` when that stretch was fast-forwarded, so the speed badge stays on screen.
- Lessons are quick: the af_bella voice at 1.12x, tight `pacing`, and the `drive` score (`kit/sound/drive.mjs`, 124 BPM). The deck's glow pulses on the score's beat.

Then catalogue the video in `src/_data/videos.json`, before the walkthrough it cuts from, and lead the docs page with `{% video "<name>" %}`. Expand the page into the same lesson: what you will learn, numbered steps with code to try, what happens underneath, and a recap.

## Narration

A narrated film has its script beside it, `films/<name>/narration.json`:

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
- **Pace.** `speed` speeds the voice up (lessons use 1.12), and `pacing` tightens or loosens the gaps around lines (`kit/sound/voice.mjs` has the defaults).
- **Music.** `score` picks an original score synthesised from code: `calm` (`kit/sound/score.mjs`, the default) or `drive` (`kit/sound/drive.mjs`), so no film carries licensed music. It ducks under the voice, and the mix is normalised to -16 LUFS.
- **Captions.** Every language in `music` gets WebVTT captions, `<name>.<lang>.vtt`. List those languages under `captions` in `videos.json`, and the page's own language shows by default.

## Heroes

`heroes/` holds the blog posts' hero images as HTML pages, one per post, sized to the hero (1672x941). Screenshot the page at that size and publish it as WebP.
