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

