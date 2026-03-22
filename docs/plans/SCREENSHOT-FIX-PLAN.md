# Screenshot Fix Plan

All feature doc pages have been **excluded from the website** (`eleventyExcludeFromCollections: true`) because their screenshots don't actually show the features they claim to demonstrate. Every screenshot is just plain code in an editor — no completion dropdowns, no error squiggles, no hover tooltips, no peek definition overlays, no profiler panels.

## Status: ALL FEATURE SCREENSHOTS BROKEN

| Page | Screenshot | What It Should Show | What It Actually Shows |
|------|-----------|---------------------|----------------------|
| Code Completions | `vscode-completions-page.png` | IntelliSense dropdown with suggestions | Plain code (CSharpSidecar.cs) |
| Diagnostics | `vscode-diagnostics-page.png` | Red/yellow squiggly underlines | Plain code (DefinitionResolver.cs) |
| Hover | `vscode-hover-page.png` | Hover tooltip with type info | Plain code (CSharpHoverBuilder.cs) |
| Go to Definition | `vscode-go-to-definition-page.png` | Peek definition overlay | Plain code (SolutionLoader.cs) |
| Profiler | `vscode-profiler-page.png` | Profiler panel/sidebar | Plain code (WorkspaceManager.cs) |
| Code Completions | `zed-completions-page.png` | IntelliSense dropdown | Plain code (CSharpSidecar.cs) |
| Diagnostics | `zed-diagnostics-page.png` | Error squiggles | Plain code (DefinitionResolver.cs) |
| Hover | `zed-hover-page.png` | Hover tooltip | Unknown (likely plain code) |
| Go to Definition | `zed-go-to-definition-page.png` | Peek definition | Unknown (likely plain code) |
| Profiler | `zed-profiler-page.png` | Profiler panel | Unknown (likely plain code) |

## What Was Excluded

These files had `eleventyNavigation` removed and `eleventyExcludeFromCollections: true` added:
- `website/src/docs/completions.md`
- `website/src/docs/diagnostics.md`
- `website/src/docs/hover.md`
- `website/src/docs/go-to-definition.md`
- `website/src/docs/profiler.md`

Footer links to these pages were also removed from `website/src/_data/navigation.json`.

Screenshot tests in `website/tests/screenshots.spec.js` were updated — the `SCREENSHOT_PAGES` array is empty until screenshots are fixed.

## What's Still Live

- Getting Started (`website/src/docs/index.md`)
- Architecture (`website/src/docs/architecture.md`)
- Editor Setup (`website/src/docs/editors.md`)
- Configuration (`website/src/docs/configuration.md`)
- Homepage (`website/src/index.njk`) — uses separate screenshots (split-editor, editor-overview, code-folding, nested-classes) that are NOT feature-specific

## How to Fix

### VS Code Screenshots

The capture script exists at `editors/vscode/screenshots/capture.mjs` with per-feature capture functions. The functions attempt to trigger features (type `this.` for completions, introduce errors for diagnostics, hover for tooltips, Alt+F12 for peek definition, click Forge sidebar for profiler) but they produce wrong results.

To fix:
1. Run `node editors/vscode/screenshots/capture.mjs completions` (or whichever screenshot)
2. Inspect the output screenshot with the Read tool
3. If the feature isn't visible, edit the capture function in `capture.mjs`
4. Re-run and re-inspect
5. Repeat until the screenshot shows the actual feature

Key issues to investigate:
- **Completions**: Does Forge's LSP actually respond to completion requests in `code serve-web`? The capture function types `this.` and waits for `.suggest-widget` — maybe the LSP isn't loaded/connected in headless mode
- **Diagnostics**: Same question — does Forge publish diagnostics in `code serve-web`? The function introduces an undefined variable and waits 5s
- **Hover**: The hover coordinates are estimated from line numbers — may be hitting the wrong pixel position
- **Go to Definition**: Alt+F12 triggers peek definition — requires the LSP to resolve definitions
- **Profiler**: Clicks the Forge sidebar tab — requires the extension to be installed and loaded in `code serve-web`

**Critical question**: Does `code serve-web` load the Forge extension? If not, none of the feature captures can work because there's no LSP providing completions, diagnostics, hover, or definitions. The script may need `--install-extension` or `--extensions-dir` flags.

### Zed Screenshots

The Zed capture script (`.claude/skills/take-screenshot/capture.sh`) can only take static window screenshots via `screencapture -l`. It cannot trigger features like completion dropdowns or hover tooltips without sending keystrokes to Zed (which is forbidden by safety rules — keystrokes hit the frontmost app, not the target).

Options:
1. **Manual capture**: Have a human trigger the feature in Zed and run the capture script at the right moment
2. **Zed extension API**: If Zed exposes an extension API for triggering completions/hover programmatically, use that
3. **AppleScript with accessibility APIs**: Use System Events to target Zed by process ID (risky, may not work)
4. **Skip Zed screenshots**: Only show VS Code screenshots on the website

## Re-enabling Pages

When screenshots are fixed:
1. Replace `eleventyExcludeFromCollections: true` with `eleventyNavigation` frontmatter in each doc file
2. Add feature links back to the footer in `website/src/_data/navigation.json`
3. Add pages back to `SCREENSHOT_PAGES` array in `website/tests/screenshots.spec.js`
4. Verify the website builds and tests pass

### Frontmatter to restore (per page)

```yaml
# completions.md
eleventyNavigation:
  key: Code Completions
  order: 4

# diagnostics.md
eleventyNavigation:
  key: Diagnostics
  order: 5

# hover.md
eleventyNavigation:
  key: Hover and Quick Info
  order: 6

# go-to-definition.md
eleventyNavigation:
  key: Go to Definition
  order: 7

# profiler.md
eleventyNavigation:
  key: Profiler
  order: 8
```
