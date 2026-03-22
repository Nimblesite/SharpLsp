# Broken Features — Agent Briefing

These LSP features are **broken in `code serve-web`** (VS Code browser mode used for automated screenshots). The website pages for these features have been excluded from navigation until fixed.

## Diagnostics — BROKEN

**Symptom**: No red/yellow squiggly underlines appear on code with errors.

**Root cause**: Forge only implements **push diagnostics** (`textDocument/publishDiagnostics`). VS Code's web client uses **pull diagnostics** (`textDocument/diagnostic` and `workspace/diagnostic`), which Forge has NOT implemented. LSP logs show:

```
Message: method not found  Code: -32603
Workspace diagnostic pull failed.
Unhandled request: workspace/diagnostic
Request textDocument/diagnostic failed.
```

**Fix**: Implement `textDocument/diagnostic` (pull model) per [LSP 3.17 Pull Diagnostics](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_pullDiagnostics). This requires a new request handler in the Rust host that forwards to the sidecar.

**Files to touch**: `src/main.rs` (request routing), sidecar diagnostic handler.

---

## Hover — BROKEN

**Symptom**: Hovering over symbols produces no tooltip. `Cmd+K Cmd+I` and command palette "Show Hover" also fail.

**Root cause**: `textDocument/hover` returns empty or fails silently. Likely causes:
1. MSBuildWorkspace hasn't fully loaded the test project
2. Sidecar can't resolve symbols because the `.csproj` isn't part of a `.sln`
3. Response times out before hover data arrives

**Fix**: Debug `textDocument/hover` with the test workspace at `editors/vscode/test-fixtures/workspace/`. Verify the sidecar loads `TestFixtures.csproj` and returns hover data for symbols in `Calculator.cs`.

**Files to touch**: `sidecars/Forge.Sidecar.CSharp/` (hover handler), test workspace config.

---

## Go to Definition — BROKEN

**Symptom**: `Alt+F12` (Peek Definition) and `F12` (Go to Definition) produce no result.

**Root cause**: Same as hover — `textDocument/definition` likely returns empty results because the sidecar hasn't loaded the workspace properly.

**Fix**: Same as hover — ensure the sidecar loads the test workspace and resolves symbol locations.

**Files to touch**: `sidecars/Forge.Sidecar.CSharp/Workspace/DefinitionResolver.cs`, test workspace config.

---

## Profiler — BROKEN (in web mode only)

**Symptom**: Forge sidebar icon (`forge-explorer`) not visible in `code serve-web`. Can't click into Profiler tree view.

**Root cause**: VS Code web may not support `viewsContainers` and `views` contributed by extensions, or the extension activation differs in web mode.

**Fix**: Check if VS Code web supports custom activity bar contributions. May need an alternative screenshot approach (e.g., desktop VS Code with `screencapture`).

**Files to touch**: `editors/vscode/package.json` (extension contributions).

---

## Zed Screenshots — All Broken

Zed's `capture.sh` script can only open a file and take a static screenshot. It cannot trigger LSP features (completions, hover, etc.) because there's no programmatic API to do so. All Zed feature screenshots show plain code only.

**Fix**: Either find a way to script Zed feature interactions (unlikely), or skip Zed screenshots for feature pages and only include them when Zed has a scripting API.

## What Works

| Feature | Status | Notes |
|---------|--------|-------|
| Homepage | OK | Plain code view, no feature trigger needed |
| Completions (VS Code) | OK | Script types `this.` to trigger IntelliSense dropdown — current screenshot shows it |
| Completions (Zed) | BROKEN | Static screenshot, no dropdown — removed from page |

## Test Workspace

Location: `editors/vscode/test-fixtures/workspace/`
- `Calculator.cs` — main test file
- `TestFixtures.csproj` — .NET 9.0 project
- `Empty.cs`, `Nested.cs`, `Greeter.fs` — additional files

## Re-enabling Pages

When a feature is fixed, restore its website page:
1. Remove `eleventyExcludeFromCollections: true` from the doc's frontmatter
2. Add back the `eleventyNavigation` frontmatter (see `docs/plans/SCREENSHOT-FIX-PLAN.md`)
3. Add the page to footer in `website/src/_data/navigation.json`
4. Add the page to `SCREENSHOT_PAGES` in `website/tests/screenshots.spec.js`
5. Run the capture script and verify the screenshot shows the feature
