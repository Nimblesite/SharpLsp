# Screenshot Fix Plan

Feature doc pages with broken screenshots have been **excluded from the website** (`eleventyExcludeFromCollections: true`). Only pages with verified working screenshots are live.

## Current Status

| Page | VS Code Screenshot | Status | Issue |
|------|-------------------|--------|-------|
| Homepage | `vscode-homepage-page.png` | LIVE | Shows Calculator.cs with syntax highlighting |
| Code Completions | `vscode-completions-page.png` | LIVE | Shows IntelliSense dropdown with suggestions |
| Diagnostics | `vscode-diagnostics-page.png` | EXCLUDED | No red squiggly underlines visible |
| Hover | `vscode-hover-page.png` | EXCLUDED | No hover tooltip visible |
| Go to Definition | `vscode-go-to-definition-page.png` | EXCLUDED | No peek definition overlay visible |
| Profiler | `vscode-profiler-page.png` | EXCLUDED | No profiler sidebar panel visible |

All Zed screenshots show plain code only — Zed cannot trigger features programmatically.

## Root Cause Analysis

The capture script (`editors/vscode/screenshots/capture.mjs`) uses `code serve-web` with Playwright. The SharpLsp VSIX is installed to `~/.vscode-server/extensions/` and the extension DOES activate (status bar shows "SharpLsp" and "C#"). The LSP sidecar IS running.

However:

### Diagnostics — LIKELY FIXED (pull diagnostics now implemented)
Pull diagnostics (`textDocument/diagnostic` and `workspace/diagnostic`) are now implemented in `pull_diagnostics.rs`. **Re-test the screenshot capture to verify diagnostics appear in `code serve-web`.**

### Hover — `textDocument/hover` returns empty or fails silently
Mouse hover over code tokens (verified correct element targeting via Playwright `boundingBox()`) and keyboard commands (`Cmd+K Cmd+I`, command palette "Show Hover") both fail to produce a visible `.monaco-hover` widget. The LSP sidecar may:
1. Return an empty hover result for tokens in the test workspace
2. Fail to resolve the symbol because MSBuildWorkspace hasn't fully loaded the project
3. Time out before the hover response arrives

**Fix**: Debug the LSP hover handler with the test workspace. Check if `textDocument/hover` returns data for symbols in `Calculator.cs`. A `.csproj` was added (`TestFixtures.csproj`) but the sidecar may need a `.sln` or may fail to locate the project.

### Go to Definition — Peek Definition doesn't render
`Alt+F12` and command palette "Peek Definition" don't produce a visible peek widget. Similar to hover — the LSP may return empty results or the sidecar hasn't loaded the workspace.

**Fix**: Same as hover — verify the sidecar loads the test workspace and returns definition locations.

### Profiler — SharpLsp sidebar not accessible
The SharpLsp activity bar icon (`sharplsp-explorer`) is not visible in `code serve-web`. The extension contributes views but they may not render in the web UI. The capture function tries to click the "SharpLsp" tab and "Profiler" tree item but neither is found.

**Fix**: Check if VS Code web supports `viewsContainers` and `views` contributed by extensions. May need a different approach for the profiler screenshot.

## Test Workspace

The test workspace at `editors/vscode/test-fixtures/workspace/` now contains:
- `Calculator.cs` — main test file for screenshots
- `TestFixtures.csproj` — .NET 9.0 project file (added to enable Roslyn sidecar)
- `Empty.cs`, `Nested.cs`, `Greeter.fs` — additional test files

## Capture Script

`editors/vscode/screenshots/capture.mjs` handles:
1. Installing the SharpLsp VSIX to both desktop and serve-web extensions directories
2. Writing workspace settings with `sharplsp.lspPath` pointing to `target/release/sharplsp`
3. Launching `code serve-web` and connecting via Playwright
4. Per-screenshot capture functions that trigger features
5. 30-second wait for LSP sidecar initialization

## Re-enabling Excluded Pages

When a feature's screenshot is fixed:
1. Replace `eleventyExcludeFromCollections: true` with the original `eleventyNavigation` frontmatter
2. Add the page to the footer in `website/src/_data/navigation.json`
3. Add the page to `SCREENSHOT_PAGES` in `website/tests/screenshots.spec.js`

### Frontmatter to restore

```yaml
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

## TODO

- [x] Implement pull diagnostics to fix `code serve-web` diagnostics — `pull_diagnostics.rs`
- [ ] Re-run screenshot capture and verify diagnostics squiggles appear
- [ ] Debug hover in `code serve-web` — check sidecar loads test workspace
- [ ] Debug go-to-definition in `code serve-web`
- [ ] Debug profiler sidebar in `code serve-web` — check `viewsContainers` API support
- [ ] Re-enable diagnostics page (restore frontmatter, add to nav + test list)
- [ ] Re-enable hover page
- [ ] Re-enable go-to-definition page
- [ ] Re-enable profiler page
