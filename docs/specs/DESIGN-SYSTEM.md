# [WEB-DESIGN] Design System

## [WEB-DESIGN-PRINCIPLES] Principles

- Use strong type hierarchy, whitespace, borders, and restrained surfaces to organize content.
- Use green as the only brand accent. Do not use purple, gradients, glows, decorative noise, or competing accent colors.
- Keep shadows functional and infrequent: menus and major product imagery only.
- Name classes for what an element is, minimize class count, and reuse existing components.
- Store colors and shared dimensions in custom properties. Component rules consume tokens rather than hardcoded colors.

## [WEB-DESIGN-CSS] CSS Architecture

The site has three CSS layers, loaded in this order:

1. [`styles.css`](../../src/website/src/assets/css/styles.css) — tokens, reset/base rules, navigation, buttons, shared headings, and footer.
2. [`pages.css`](../../src/website/src/assets/css/pages.css) — homepage, blog index, releases, grids, cards, and page-specific composition.
3. [`prose.css`](../../src/website/src/assets/css/prose.css) — long-form docs, blog posts, release notes, and documentation navigation.

Shared primitives belong in `styles.css`; page composition belongs in `pages.css`; rendered Markdown and its supporting article/docs components belong in `prose.css`. Do not duplicate rules across layers.

## [WEB-DESIGN-COLOR] Color

Light and dark themes use the same semantic tokens. `data-theme="dark"` on `<html>` supplies the dark values and `color-scheme` informs browser controls.

| Token | Light | Dark | Purpose |
|---|---:|---:|---|
| `--color-bg` | `#f6f7f7` | `#0d110f` | Page canvas |
| `--color-surface` | `#ffffff` | `#131916` | Cards and menus |
| `--color-surface-subtle` | `#eef0ef` | `#19211d` | Quiet grouping and hover states |
| `--color-surface-strong` | `#dee1e0` | `#25302a` | Stronger neutral surface |
| `--color-text` | `#161c19` | `#f1f4f2` | Primary text |
| `--color-muted` | `#58625d` | `#aab4af` | Supporting text |
| `--color-soft` | `#78827d` | `#87938d` | De-emphasized text |
| `--color-border` | `#d4dad7` | `#28332d` | Standard dividers |
| `--color-border-strong` | `#aeb8b3` | `#46554d` | Emphasized boundaries |
| `--color-primary` | `#0f7f49` | `#49d491` | Links, focus, labels, primary actions |
| `--color-primary-hover` | `#09663a` | `#84d6ae` | Primary hover state |
| `--color-primary-soft` | `#dcefe5` | `#183a29` | Selected and quiet accent surfaces |
| `--color-on-primary` | `#ffffff` | `#07110b` | Text on primary |
| `--color-code` | `#101613` | `#080c0a` | Code-block surface |
| `--color-code-text` | `#e7ece9` | `#e7ece9` | Code-block text |

## [WEB-DESIGN-TYPE] Typography and Icons

Use system fonts only. The UI stack is `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`; the code stack is `"SFMono-Regular", "Cascadia Code", "Liberation Mono", Consolas, monospace`.

Body copy is `1rem/1.65`. Display headings use responsive `clamp()` sizing, tight negative letter spacing, and compact line height. Long-form prose uses a more relaxed `1.78` line height.

Do not request web fonts or external icon fonts. Use existing local assets, text symbols, or small accessible inline SVGs with `currentColor` for interface icons.

## [WEB-DESIGN-SPACING] Spacing and Shape

Spacing follows a 4px base scale:

| Token | Value |
|---|---:|
| `--space-1` | `0.25rem` |
| `--space-2` | `0.5rem` |
| `--space-3` | `0.75rem` |
| `--space-4` | `1rem` |
| `--space-6` | `1.5rem` |
| `--space-8` | `2rem` |
| `--space-12` | `3rem` |
| `--space-16` | `4rem` |

Radii are `0.35rem`, `0.65rem`, and `1rem` through `--radius-sm`, `--radius-md`, and `--radius-lg`. Prefer borders over elevation. `--shadow-sm` and `--shadow-lg` are neutral shadows, never colored glows.

## [WEB-DESIGN-LAYOUT] Layout

| Context | Token | Limit |
|---|---|---:|
| Main shell | `--max-width` | `1120px` |
| Docs and article frame | `--content-width` | `56rem` |
| Long-form reading measure | `--reading-width` | `46rem` |
| Docs sidebar | `--sidebar-width` | `16rem` |
| Site header | `--header-height` | `4rem` |

Main page sections center within the shell and retain fluid side gutters. Article titles, media, code, and tables use the full editorial frame; paragraphs, lists, quotes, and secondary headings use the narrower reading measure. The docs sidebar collapses below `1024px` so it never crushes the prose column. Images are responsive by default, and wide code blocks, diagrams, and tables scroll within their own bounds rather than widening the page.

## [WEB-DESIGN-HERO] Home Hero

The home hero is one screen. On desktop it fills the viewport below the header, no more and no less: a compact copy column aligned to the shell sits beside the product film, which runs out to the window's right edge and is capped so the whole film stays above the fold. The headline is one short sentence plus the accent line, at most `3.25rem`, and never taller than a third of the viewport. Below `1024px` the copy stacks above the film at full width.

## [WEB-DESIGN-DOCS-NAV] Docs Navigation

The docs sidebar groups pages by what the reader is doing. The groups are declared once, in `navigation.json` (`docs`), with their labels in `i18n.json` (`docs.groups`):

| Group | Pages |
|---|---|
| Set up | Getting Started, Editor Setup, Configuration |
| Write code | F# Language Support, Code Completions, Hover & Quick Info, Go to Definition, Diagnostics, Refactoring & Code Actions |
| Project tools | Context Menus, NuGet Package Manager, Profiler |
| For contributors | Architecture, Contributing |

- Every docs page appears in exactly one group, in every language, and links stay within the page's language.
- F# leads "Write code".
- Pages for people building SharpLsp, not using it, go in "For contributors". That group comes last, below a rule, as a disclosure that stays folded unless the current page is in it.
- The current page is marked `aria-current="page"`.
- At and below `1024px` the sidebar is an off-canvas drawer:
  - its full-width menu control sticks under the header as the reader scrolls;
  - the drawer opens directly beneath that control and reaches the bottom of the screen;
  - every entry is a 44px touch target;
  - Escape, or a tap beside the drawer, closes it.

## [WEB-DESIGN-COMPONENTS] Components

Primary and secondary actions use `.button` with `.primary` or `.secondary`; `.nav-button` shares the same control geometry. Controls have a minimum height of `2.75rem` (44px), a visible border or fill, and a clear hover/focus state.

Cards use a neutral surface, one-pixel border, restrained radius, and content-driven spacing. Hover may strengthen the border but must not add movement or spectacle. Grids use `minmax(0, 1fr)` where content could otherwise overflow.

## [WEB-DESIGN-PROSE] Prose Contract

Every documentation page, blog post, and other long-form rendered body must use the `.prose` wrapper. Markdown typography must never rely on unscoped element selectors.

Within `.prose`:

- headings, paragraphs, lists, links, quotes, media, tables, and code receive the canonical reading styles;
- links are visibly underlined and use `--color-primary`;
- inline code and code blocks remain visually distinct and horizontally safe;
- tables are scrollable, and media never exceeds the content width;
- article callouts, author metadata, related content, and docs navigation use the supporting rules in `prose.css`.

Page-level grids and marketing card styles must not leak into `.prose`. Do not recreate prose styling in templates or `pages.css`.

## [WEB-DESIGN-MEDIA] Product Media

Screenshots and video of a SharpLsp feature show the real extension, never a mock-up.

- **Capture.** The profiler media is shot by `src/website/tools/profiler-film/`. `capture.mjs` drives an isolated VS Code (its own user-data and extensions directories, never the user's editor) running the packaged VSIX against a real .NET app, and records stills and real-time screencasts. `render.mjs` turns them into the site's assets.
- **Honesty.** Footage plays in real time unless the frame says otherwise: every fast-forwarded stretch carries an on-screen speed marker, and captions name time-lapses. Motion graphics (title cards, camera moves, highlights, the cursor) frame the footage but never alter what the editor shows.
- **Privacy.** No frame may show a user name, home directory, hostname or terminal. The demo app runs from a neutral temporary path and the terminal is never opened.
- **Formats.**
  - Films ship as H.264 MP4 and VP9 WebM with a WebP poster.
  - Stills ship as WebP, 2400px wide, with `width` and `height` set.
  - Marketing pages may autoplay a film only when it is muted and looping; docs pages use controls.
  - Every autoplaying video pauses and shows its controls under `prefers-reduced-motion: reduce`.
  - Every video ships a WebP poster, the films and the recordings alike.
- **One catalogue.** Every video on the site is declared once in `src/website/src/_data/videos.json`: encodings, size, length, upload date, and its label and caption in each language. Pages place a video with the `{% video "<id>" %}` shortcode (`src/website/video-figure.js`) and never repeat `<video>` markup. The shortcode renders in the page's language and emits a schema.org `VideoObject` whose name is the player's label, so search results describe exactly what a reader hears.
- **Placement.** A video goes wherever a page talks about what it shows: the home page (the profiler film autoplaying in the hero, the CPU recording in the profiler section), the Getting Started page (the tour), the profiler docs (the film and both recordings), and every blog post that discusses the profiler or the editor experience, in every language the page is published in.

## [WEB-DESIGN-RESPONSIVE] Responsive Behavior

Design mobile-first: content order, meaning, and actions must work in a single column without hover. `768px` is the primary responsive boundary; at and below it:

- navigation becomes an explicit menu with stacked links and actions;
- multi-column workflows, reasons, releases, blog cards, and language sections collapse to one column;
- featured posts return to normal card flow;
- primary action rows stack to full-width controls where needed;
- the docs sidebar becomes an off-canvas drawer opened by a sticky full-width menu control ([WEB-DESIGN-DOCS-NAV]);
- prose and shell gutters reduce to `1rem`.

At `380px`, proof items become one column and dense release metadata stacks. New components must remain usable at 320px without horizontal page overflow.

## [WEB-DESIGN-ACCESSIBILITY] Accessibility

- Preserve semantic HTML, logical heading order, and meaningful link/control labels.
- Preserve the skip link and the `3px` `:focus-visible` outline with a `3px` offset.
- Interactive targets must be at least 44px in the constrained dimension and remain keyboard operable.
- Do not communicate state by color alone. Maintain readable contrast in both themes.
- Decorative SVGs are hidden from assistive technology; meaningful images and icons require accessible text.
- Honor `prefers-reduced-motion`; essential information must never depend on animation or hover.
