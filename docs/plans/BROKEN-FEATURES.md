# Broken Features — Agent Briefing

These LSP features are **broken in `code serve-web`** (VS Code browser mode used for automated screenshots). The website pages for these features have been excluded from navigation until fixed.

## Diagnostics — PARTIAL (pull handlers wired; refresh cycle + restore gate pending)

**Symptom**: No red/yellow squiggly underlines appear on code with errors. Separately: phantom CS0246 errors for types that exist (the solution builds fine).

**Root causes**:
1. **Pull diagnostics missing** (squiggle visibility): VS Code's web client uses LSP 3.17 pull diagnostics; Forge originally only implemented push.
2. **Eager solution-wide scan + verification pass lied** (phantom errors): the previous architecture scanned all projects on workspace open via `workspace/diagnostics/all`, which hit Roslyn's `GetCompilationAsync` before NuGet restore / `CompilationReference`s / source generators had stabilized — producing CS0246 for types that resolve fine. The "verification pass" tried to repair this by re-sending `didChange` with the same disk text, which doesn't re-resolve metadata references, so the phantom errors persisted.

**Status**:
- `textDocument/diagnostic` and `workspace/diagnostic` handlers exist in `pull_diagnostics.rs` ✅
- `previousResultId` round-trip + `{ kind: "unchanged" }` reporting — pending [DIAGNOSTICS-PLAN Phase 5](DIAGNOSTICS-PLAN.md#phase-5-pull-diagnostics--refresh-cycle-p0--primary-path)
- Sidecar `IDiagnosticsRefresher` equivalent + `workspace/diagnostic/refresh` (debounced 2000ms) — pending Phase 5
- NuGet restore gate before `MSBuildWorkspace.OpenSolutionAsync` — pending [Phase 5.6](DIAGNOSTICS-PLAN.md#phase-56-nuget-restore-gate-p0); this is the single biggest fix for phantom CS0246
- Eager scan + verification pass — to be **deleted** in Phase 5; the spec rationale lives in [DIAGNOSTICS-SPEC §1.2](../specs/DIAGNOSTICS-SPEC.md#12-why-no-eager-solution-scan) and [§10.3](../specs/DIAGNOSTICS-SPEC.md#103-why-the-previous-verification-pass-is-gone)

**Re-test in `code serve-web`**: pull handlers should already deliver squiggles for open files. Phantom errors will only fully clear once Phase 5.6 (restore gate) lands.

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

## TODO

- [x] Implement pull diagnostics (`textDocument/diagnostic`, `workspace/diagnostic`) — `pull_diagnostics.rs`
- [ ] Re-test diagnostics screenshot in `code serve-web` and re-enable the page if fixed
- [ ] Debug hover in `code serve-web` — verify sidecar loads `TestFixtures.csproj` and returns hover data
- [ ] Debug go-to-definition in `code serve-web` — verify sidecar resolves symbol locations
- [ ] Re-enable excluded website pages once their screenshots are fixed (see SCREENSHOT-FIX-PLAN for frontmatter)
