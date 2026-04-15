# DIAGNOSTICS-PLAN

Implementation plan for [DIAGNOSTICS-SPEC](../specs/DIAGNOSTICS-SPEC.md).

> **Architecture pivot (current).** The previous push-based, eager-solution-scan plan produced phantom CS0246/CS0234 errors during workspace load and could not be repaired by the verification pass. The plan now mirrors `Microsoft.CodeAnalysis.LanguageServer` (the engine behind C# Dev Kit): NuGet restore gate → workspace open → pull-driven diagnostics with `global_state_version`-keyed `resultId` → debounced `workspace/diagnostic/refresh`. See [DIAGNOSTICS-SPEC §1.1](../specs/DIAGNOSTICS-SPEC.md#11-the-pull--refresh-cycle). Phases 1–2 below are partially completed; the parts that still apply are kept, the parts that contradict the new architecture are marked obsolete with rationale.

## Phase 1: Per-Document Diagnostics IPC (P0) — DONE

The sidecar's per-document diagnostics path is correct and survives the pivot. The Rust host's push wiring stays as the LSP-3.16 fallback for editors that don't negotiate pull.

### Rust LSP Host

- [x] Create `diagnostics` module in Rust host (`src/diagnostics.rs`)
- [x] Map sidecar `DiagnosticResult` → LSP `Diagnostic` struct
  - Map severity: `"Error"` → 1, `"Warning"` → 2, `"Info"` → 3, `"Hidden"` → 4
  - Map code, message, range
  - Set `source: "forge-csharp"`
- [x] On `textDocument/didOpen` / `textDocument/didChange` / `textDocument/didSave`: request diagnostics from sidecar (background task) — kept as the push fallback path
- [x] Send `textDocument/publishDiagnostics` notification with mapped results — push fallback only; pull is primary (Phase 5)
- [x] Clear diagnostics on `textDocument/didClose`
- [ ] Add debounce (150ms window) before sidecar push request — superseded by Phase 5's 2000ms refresh debounce; only relevant if push fallback is in use
- [x] Rust e2e tests: `test_diagnostics_cleared_on_close`, `test_request_works_after_diagnostic_notification`
- [x] VSCode extension tests: `diagnostics.test.ts` (6 tests — error detection, missing type, clean file, edit cycle, range check, close clears)
- [ ] Full-stack test: open a file with real errors → errors appear in Problems panel (requires sidecar)

### C# Sidecar

- [x] `workspace/diagnostics` handler exists (`CSharpSidecar.HandleDiagnosticsAsync`) — extended in Phase 5 to accept `previousResultId` and emit `Changed` flag
- [x] `WorkspaceManager.GetDiagnosticsAsync` extracts from `SemanticModel.GetDiagnostics()`
- [x] `DiagnosticResult` MessagePack type defined

## Phase 2: Solution-Wide Eager Scan (P0) — REMOVED

> ⚠️ **Removed by architecture pivot.** This phase implemented the eager `workspace/diagnostics/all` bulk RPC and the post-load solution scan. The eager scan iterates `Solution.Projects` and calls `GetCompilationAsync()` on each, which produces phantom CS0246/CS0234 because consumer projects are compiled before their dependencies are cached as `CompilationReference`s. The replacement is Phase 5 (pull-driven workspace diagnostics) plus Phase 5.6 (NuGet restore gate). See [DIAGNOSTICS-SPEC §1.2](../specs/DIAGNOSTICS-SPEC.md#12-why-no-eager-solution-scan).

### Rust LSP Host

- [x] Read `diagnostics.solution_wide_analysis` from config (default: `true`) — kept; now controls whether the server answers `workspace/diagnostic` pulls
- [x] Read `diagnostics.project_filter` from config (default: empty = all projects) — kept; now restricts `workspace/diagnostic` results
- [x] On solution load: request solution-wide diagnostics — ⚠️ **OBSOLETE.** Removed. The host no longer triggers a scan on load; the editor pulls when it wants data. `request_solution_in_background` in `src/diagnostics.rs` will be deleted in Phase 5.
- [x] Stream diagnostics incrementally (batch by file) to avoid blocking — ⚠️ **OBSOLETE.** Replaced by `workspace/diagnostic` partial-result streaming in Phase 5.
- [ ] On file change: re-request diagnostics for changed file + dependents — ⚠️ **OBSOLETE.** Replaced by `diagnostics/refresh` IPC + debounced `workspace/diagnostic/refresh` in Phase 5.
- [x] Advertise `workspaceDiagnostics: true` in server capabilities — kept; required for pull workspace diagnostics

### C# Sidecar

- [x] Add `workspace/diagnostics/all` IPC handler — ⚠️ **TO BE DELETED in Phase 5.** Caused phantom CS0246s on workspace load.
- [x] Add `GetAllDiagnosticsAsync(string[]? projectFilter, CancellationToken)` to `WorkspaceManager` — ⚠️ **TO BE DELETED in Phase 5.** Same reason.
  - The topological-order patch landed on `OrderProjectsByDependencies` (`WorkspaceManager.cs`) was a partial mitigation. It does not survive: source generators and NuGet still race even with topological iteration. The function is removed entirely.
- [ ] Stream results — send partial diagnostics as each project completes — **moved to Phase 5** as part of `workspace/diagnostic` partial-result streaming.

### Configuration

- [x] `DiagnosticsConfig.solution_wide_analysis` field exists (default: `true`)
- [x] `DiagnosticsConfig.analyzers_enabled` field exists (default: `true`)
- [x] Add `project_filter: Vec<String>` to `DiagnosticsConfig`
- [ ] Add `min_severity: String` to `DiagnosticsConfig` (default: `"hint"`)
- [ ] Add `max_per_file: u32` to `DiagnosticsConfig` (default: `0` = unlimited)
- [ ] Hot-reload config via `workspace/didChangeConfiguration`

## Phase 3: F# Diagnostics (P0 — parallel with C#)

- [ ] `FSharpCheckFileResults.Diagnostics` integration in F# sidecar
- [ ] Map F# diagnostic severity to LSP
- [ ] Solution-wide F# analysis via `FSharpChecker`
- [ ] FSharpLint integration for code style
- [ ] FSharp.Analyzers.SDK plugin loading

## Phase 4: Analyzer Diagnostics (P0)

- [ ] Enable Roslyn `DiagnosticAnalyzer` framework in sidecar
  - `CompilationWithAnalyzers.GetAnalyzerDiagnosticsAsync()`
- [ ] Load analyzers from project NuGet references
- [ ] Load .editorconfig severity overrides
- [ ] IDE0005 (unused usings) detection
- [ ] Map analyzer diagnostic codes to LSP `Diagnostic.code` + `codeDescription` URL

## Phase 5: Pull Diagnostics + Refresh Cycle (P0 — primary path)

This is now the **primary** diagnostic pipeline. Pull is mandatory for editors that advertise `textDocument.diagnostic` client capability; push (Phase 1 wiring) is fallback only. Implements [DIAGNOSTICS-SPEC §1.1](../specs/DIAGNOSTICS-SPEC.md#11-the-pull--refresh-cycle), [§4.2](../specs/DIAGNOSTICS-SPEC.md#42-pull-model-primary-textdocumentdiagnostic-workspacediagnostic), [§4.3](../specs/DIAGNOSTICS-SPEC.md#43-refresh-notifications-workspacediagnosticrefresh).

### Rust LSP Host

- [x] Implement `textDocument/diagnostic` request handler (LSP 3.17 pull model) — `pull_diagnostics.rs`
- [x] Implement `workspace/diagnostic` request handler — `pull_diagnostics.rs`
- [ ] Forward `previousResultId` to sidecar in IPC payload
- [ ] Return `RelatedFullDocumentDiagnosticReport` when changed, `RelatedUnchangedDocumentDiagnosticReport` (`{ kind: "unchanged" }`) when sidecar reports `Changed = false`
- [ ] Construct `resultId = "p:{project_version}|d:{doc_version}|g:{global_state_version}"` from sidecar response fields
- [ ] `workspace/diagnostic` partial-result streaming via `WorkDoneProgress` partialResultToken — emit one `WorkspaceDocumentDiagnosticReport` per project as it completes
- [ ] Subscribe to sidecar `diagnostics/refresh` IPC notification (defined in [SPEC §5.4](../specs/DIAGNOSTICS-SPEC.md#54-notification-diagnosticsrefresh))
- [ ] Implement debounced refresh queue: `tokio::sync::Notify` + 2000ms `tokio::time::sleep` collapse, matches `Microsoft.CodeAnalysis.LanguageServer`'s `AsyncBatchingWorkQueue`
- [ ] Send LSP `workspace/diagnostic/refresh` notification when the debounce drains
- [ ] **Delete** `request_solution_in_background` from `src/diagnostics.rs` (the eager-scan trigger)
- [ ] **Delete** `verify_error_files`, `sync_text_to_sidecar` from `src/diagnostics.rs` (verification pass — see Phase 5.5)
- [ ] Cancel in-flight per-document IPC pulls when editor sends a fresh pull for the same document
- [ ] Server capability: add `diagnosticProvider.identifier = "forge"` so editors distinguish Forge's diagnostics

### C# Sidecar

- [ ] Extend `workspace/diagnostics` IPC payload to `DiagnosticsRequest { FilePath, PreviousResultId? }`
- [ ] Extend response to include `ResultId` and `Changed` flag; return empty items when `Changed = false`
- [ ] Add `workspace/diagnostics/pull` IPC handler — streams per-document `WorkspaceDocumentDiagnosticReport`s via partial responses (replaces the deleted `workspace/diagnostics/all`)
- [ ] Add `WorkspaceDiagnosticsCache` keyed by `(DocumentId, ProjectVersion, DocumentVersion, GlobalStateVersion)` — mirrors Roslyn's `VersionedPullCache`
- [ ] Add `IDiagnosticsRefresher` equivalent: `GlobalStateVersion: ulong` field + `RefreshRequested` event
- [ ] Subscribe to `_workspace.RegisterWorkspaceChangedHandler` — on `ProjectAdded`, `ProjectReloaded`, `ProjectRemoved`, `SolutionAdded`, `SolutionChanged`, `SolutionReloaded`, `DocumentChanged`, increment `GlobalStateVersion` and fire `RefreshRequested`
- [ ] Add `diagnostics/refresh` outbound IPC notification (sidecar → host) carrying `{ GlobalStateVersion, AffectedProjectIds[] }`
- [ ] Add `workspace/initializationComplete` outbound IPC notification fired once after restore + `OpenSolutionAsync` complete
- [ ] **Delete** `GetAllDiagnosticsAsync` from `WorkspaceManager`
- [ ] **Delete** `OrderProjectsByDependencies` (added as a partial mitigation; obsolete now that the eager scan is gone)
- [ ] **Delete** `workspace/diagnostics/all` handler from `CSharpSidecar`
- [ ] Skip auto-generated syntax trees (`syntaxTree.IsAutoGenerated`, `GeneratedKind.MarkedGenerated`) — matches OmniSharp's behavior; prevents diagnostics on `obj/Debug/.../*.AssemblyInfo.cs` etc.

### Tests

- [ ] Full-stack: pull diagnostics during workspace load returns "loading" or partial results, never CS0246 for resolvable types
- [ ] Full-stack: `previousResultId` round-trip — repeat pull returns `{ kind: "unchanged" }`
- [ ] Full-stack: workspace mutation triggers `workspace/diagnostic/refresh` within 2.5s (debounce + slack)
- [ ] Full-stack: editing a file invalidates only its project's `resultId`s; unrelated files' pulls return unchanged
- [ ] Full-stack: 8-project diamond graph (the current `test_full_stack_cross_project_references_no_false_positives` fixture) — pull never returns phantom CS0246

## Phase 5.5: Diagnostic Verification (P0) — REMOVED

> ⚠️ **Removed by architecture pivot.** The verification pass re-sent `textDocument/didChange` with the same disk text and re-fetched diagnostics, expecting Roslyn to clear false positives. It does not work — `Solution.WithDocumentText` does not re-resolve metadata references or re-run source generators, so the same phantom errors come back. The pull + refresh model in Phase 5 removes the pass's reason to exist: Forge no longer asserts diagnostics until the editor pulls. See [DIAGNOSTICS-SPEC §10.3](../specs/DIAGNOSTICS-SPEC.md#103-why-the-previous-verification-pass-is-gone).

Original tasks (kept here for traceability — every item is undone in Phase 5):

- [x] `didOpen` syncs document text to sidecar via `notify_did_change` — kept (it's a correct text-sync operation, just no longer part of a verification pipeline)
- [x] After solution-wide scan, verification pass re-checks files with errors/warnings — ⚠️ **DELETED** (`verify_error_files` removed in Phase 5)
- [x] Verification publishes corrected diagnostics per-file (clears false positives) — ⚠️ **DELETED** (no push during load)
- [x] Verification yields between files to avoid starving other sidecar requests — ⚠️ **DELETED**
- [x] Test: `test_full_stack_diagnostics_cleared_after_error_fixed` (deterministic) — kept; now exercises pull semantics (close → fixed file → pull returns clean)
- [ ] Exponential backoff for persistent errors (1s, 2s, 4s, max 30s) — ⚠️ **NOT NEEDED.** Pulls run only when the editor asks; there is no retry loop to back off.
- [ ] Periodic re-verification for long-running sessions — ⚠️ **NOT NEEDED.** Workspace events drive `diagnostics/refresh`; the editor re-pulls on its own schedule.

## Phase 5.6: NuGet Restore Gate (P0)

The single biggest source of phantom CS0246 is unresolved NuGet `<PackageReference>` items at workspace open. Mirrors `Microsoft.CodeAnalysis.LanguageServer.HostWorkspace.ProjectDependencyHelper`. Implements [DIAGNOSTICS-SPEC §6](../specs/DIAGNOSTICS-SPEC.md#6-nuget-restore-gate).

### C# Sidecar

- [ ] Add `Workspace/ProjectRestorer.cs`: inspect each project's `obj/project.assets.json`, compare timestamp + `PackageReference` set against `.csproj`
- [ ] Add `Workspace/DotnetCliHelper.cs`: shell `dotnet restore <path> --verbosity quiet`, capture stdout/stderr, surface failures as a structured error
- [ ] In `WorkspaceManager.OpenCoreAsync`: call `ProjectRestorer.RestoreIfStaleAsync(target, ct)` BEFORE `MSBuildWorkspace.Create(...)`
- [ ] Honor `diagnostics.auto_restore_on_open` config flag (default true) — when false, skip restore and surface a server-side warning notification
- [ ] After restore completes successfully, increment `GlobalStateVersion` and fire `diagnostics/refresh`
- [ ] After restore + `OpenSolutionAsync` complete, fire `workspace/initializationComplete` outbound IPC notification

### Rust LSP Host

- [ ] On workspace open: create LSP `$/progress` work-done token (`workspace/forge-load`)
- [ ] Forward sidecar restore progress (start, per-project status, end) via `$/progress` notifications
- [ ] On `workspace/initializationComplete` from sidecar: send LSP `workspace/projectInitializationComplete` (custom notification, matches Roslyn LSP contract); end the work-done progress
- [ ] Add `diagnostics.auto_restore_on_open` to `DiagnosticsConfig` (default true)

### Tests

- [ ] Full-stack: workspace with stale `assets.json` (delete it) → server triggers restore on open, no CS0246 for NuGet types after init complete
- [ ] Full-stack: workspace with `diagnostics.auto_restore_on_open = false` → server publishes a warning, leaves diagnostics in incomplete state, does not lie about success
- [ ] Full-stack: `workspace/projectInitializationComplete` notification fires exactly once per workspace open

## Phase 6: Background Analysis Optimization (P1)

- [ ] Cache `Project.GetCompilationAsync` results across pulls within the same `Solution` snapshot (Roslyn does this internally — verify our IPC layer doesn't defeat it)
- [ ] Cancel stale per-document IPC pulls on new pulls for the same document
- [ ] Memory budget: cap `WorkspaceDiagnosticsCache` size; LRU-evict by `GlobalStateVersion` age
- [ ] Progress reporting via `$/progress` for `workspace/diagnostic` pulls (in addition to load progress from Phase 5.6)

---

## TODO

### Done
- [x] **Rust host**: Create `diagnostics` module (`src/diagnostics.rs`)
- [x] **Rust host**: Map sidecar `DiagnosticResult` → LSP `Diagnostic`
- [x] **Rust host**: On `didOpen`/`didChange`/`didSave` → request diagnostics from sidecar (push fallback path)
- [x] **Rust host**: Send `textDocument/publishDiagnostics` to editor (push fallback path)
- [x] **Rust host**: Clear diagnostics on `textDocument/didClose`
- [x] **Rust host**: Read `diagnostics.solution_wide_analysis` from config
- [x] **Rust host**: Read `diagnostics.project_filter` from config
- [x] **Rust host**: `didOpen` syncs text to sidecar via `notify_did_change` (text-sync, kept)
- [x] **Rust host**: Advertise `workspaceDiagnostics: true` in capabilities
- [x] **Rust host**: Implement `textDocument/diagnostic` pull handler (LSP 3.17) — `pull_diagnostics.rs`
- [x] **Rust host**: Implement `workspace/diagnostic` pull handler — `pull_diagnostics.rs`
- [x] **Config**: Add `project_filter: Vec<String>` to `DiagnosticsConfig`
- [x] **Test**: Rust e2e — didClose sends empty publishDiagnostics
- [x] **Test**: Rust e2e — request() skips diagnostic notifications
- [x] **Test**: VSCode — file with type error shows diagnostics
- [x] **Test**: VSCode — file with missing type shows diagnostics
- [x] **Test**: VSCode — valid file has no error diagnostics
- [x] **Test**: VSCode — fixing an error clears the diagnostic
- [x] **Test**: VSCode — diagnostics have correct severity and range
- [x] **Test**: VSCode — closing a document clears its diagnostics
- [x] **Test**: Full-stack — close/reopen with fixed source clears stale diagnostics
- [x] **Test**: Full-stack — `test_full_stack_cross_project_references_no_false_positives` (8-project diamond, regression guard)

### Removed (obsolete after architecture pivot)
- [x] ~~**Rust host**: On solution load, request solution-wide diagnostics~~ — `request_solution_in_background` to be deleted in Phase 5; eager scan caused phantom CS0246s
- [x] ~~**Rust host**: Stream diagnostics incrementally by file~~ — push streaming replaced by `workspace/diagnostic` partial-result streaming
- [x] ~~**Rust host**: Verification pass re-checks files with errors after solution-wide scan~~ — `verify_error_files` to be deleted in Phase 5; band-aid that didn't work
- [x] ~~**C# sidecar**: Add `workspace/diagnostics/all` IPC handler~~ — to be deleted in Phase 5
- [x] ~~**C# sidecar**: Add `GetAllDiagnosticsAsync` to `WorkspaceManager`~~ — to be deleted in Phase 5
- [ ] ~~**Rust host**: Add debounce (150ms) before sidecar request~~ — superseded by Phase 5's 2000ms refresh debounce
- [ ] ~~**Rust host**: Re-request diagnostics for changed file + dependents~~ — replaced by `diagnostics/refresh` in Phase 5
- [ ] ~~**Rust host**: Priority queue: active > visible > recent > rest~~ — pull model makes the editor the prioritizer; not needed
- [ ] ~~**Rust host**: Cancel stale analysis on new edits~~ — moved to Phase 5 (cancel stale per-document IPC pulls)

### Phase 5 — Pull + refresh (P0, primary path)
- [ ] **Rust host**: Forward `previousResultId` to sidecar in IPC payload
- [ ] **Rust host**: Return `{ kind: "unchanged" }` when sidecar reports `Changed = false`
- [ ] **Rust host**: Construct `resultId = "p:{pv}|d:{dv}|g:{gsv}"` from sidecar response
- [ ] **Rust host**: `workspace/diagnostic` partial-result streaming via `partialResultToken`
- [ ] **Rust host**: Subscribe to `diagnostics/refresh` IPC notification
- [ ] **Rust host**: Debounced refresh queue (2000ms) → LSP `workspace/diagnostic/refresh`
- [ ] **Rust host**: Delete `request_solution_in_background`, `verify_error_files`, `sync_text_to_sidecar`
- [ ] **Rust host**: Cancel in-flight per-document IPC pulls when fresher pull arrives
- [ ] **Rust host**: Server capability `diagnosticProvider.identifier = "forge"`
- [ ] **C# sidecar**: Extend `workspace/diagnostics` IPC payload with `PreviousResultId`; response with `ResultId` + `Changed`
- [ ] **C# sidecar**: Add `workspace/diagnostics/pull` handler with partial-response streaming
- [ ] **C# sidecar**: Add `WorkspaceDiagnosticsCache` keyed on `(DocumentId, ProjectVersion, DocumentVersion, GlobalStateVersion)`
- [ ] **C# sidecar**: Add `IDiagnosticsRefresher` equivalent (`GlobalStateVersion: ulong` + `RefreshRequested` event)
- [ ] **C# sidecar**: Subscribe to `_workspace.RegisterWorkspaceChangedHandler`; bump version on relevant `WorkspaceChangeKind`s
- [ ] **C# sidecar**: Emit `diagnostics/refresh` outbound notification with `{ GlobalStateVersion, AffectedProjectIds[] }`
- [ ] **C# sidecar**: Emit `workspace/initializationComplete` outbound notification once after init
- [ ] **C# sidecar**: Delete `GetAllDiagnosticsAsync`, `OrderProjectsByDependencies`, `workspace/diagnostics/all` handler
- [ ] **C# sidecar**: Skip auto-generated syntax trees (`syntaxTree.IsAutoGenerated`)
- [ ] **Test**: Pull during workspace load returns "loading" or partial — never CS0246 for resolvable types
- [ ] **Test**: `previousResultId` round-trip → `{ kind: "unchanged" }`
- [ ] **Test**: Workspace mutation triggers `workspace/diagnostic/refresh` within 2.5s
- [ ] **Test**: Editing a file invalidates only its project's `resultId`s

### Phase 5.6 — NuGet restore gate (P0)
- [ ] **C# sidecar**: `Workspace/ProjectRestorer.cs` (assets.json staleness check)
- [ ] **C# sidecar**: `Workspace/DotnetCliHelper.cs` (shell `dotnet restore`)
- [ ] **C# sidecar**: Call `RestoreIfStaleAsync` in `OpenCoreAsync` before `MSBuildWorkspace.Create`
- [ ] **C# sidecar**: Honor `auto_restore_on_open` config flag
- [ ] **C# sidecar**: Bump `GlobalStateVersion` + `diagnostics/refresh` after restore
- [ ] **Rust host**: `$/progress` work-done token for workspace load
- [ ] **Rust host**: Forward sidecar restore progress as `$/progress` events
- [ ] **Rust host**: Send LSP `workspace/projectInitializationComplete` on init complete
- [ ] **Config**: Add `auto_restore_on_open: bool` to `DiagnosticsConfig` (default true)
- [ ] **Config**: Add `refresh_debounce_ms: u32` to `DiagnosticsConfig` (default 2000)
- [ ] **Test**: Stale `assets.json` → restore on open → no CS0246 for NuGet types
- [ ] **Test**: `auto_restore_on_open = false` → server warns, does not lie about success
- [ ] **Test**: `workspace/projectInitializationComplete` fires exactly once per open

### Analyzer pipeline (Phase 4 unchanged, depends on Phase 5)
- [ ] **C# sidecar**: Enable `CompilationWithAnalyzers.GetAnalyzerSemanticDiagnosticsAsync()` in per-document pull path
- [ ] **C# sidecar**: Load NuGet analyzer references
- [ ] **C# sidecar**: Load .editorconfig severity overrides
- [ ] **C# sidecar**: IDE0005 (unused usings) detection
- [ ] **C# sidecar**: Map analyzer codes to `codeDescription` URLs

### F# sidecar (Phase 3 unchanged)
- [ ] **F# sidecar**: `FSharpCheckFileResults.Diagnostics` integration
- [ ] **F# sidecar**: Map F# diagnostic severity to LSP
- [ ] **F# sidecar**: Solution-wide F# analysis via `FSharpChecker` (per-document, pull-driven)
- [ ] **F# sidecar**: Equivalent `IDiagnosticsRefresher` + workspace event subscription
- [ ] **F# sidecar**: FSharpLint integration
- [ ] **F# sidecar**: FSharp.Analyzers.SDK plugin loading

### Config remaining
- [ ] **Config**: Add `min_severity: String` to `DiagnosticsConfig`
- [ ] **Config**: Add `max_per_file: u32` to `DiagnosticsConfig`
- [ ] **Config**: Hot-reload via `workspace/didChangeConfiguration` (bump `global_state_version`, fire refresh)

### Tests remaining
- [ ] **Test**: Full-stack — open file with errors → errors in Problems panel via pull
- [ ] **Test**: Solution-wide pull surfaces errors in unopened files
- [ ] **Test**: Project filter excludes specified projects from `workspace/diagnostic`
- [ ] **Test**: Sidecar crash recovery preserves last-known `resultId` cache (or invalidates atomically)

## Phase 7: Advanced Analysis

- [ ] Code metrics (cyclomatic complexity)
- [ ] Value tracking / data flow analysis
