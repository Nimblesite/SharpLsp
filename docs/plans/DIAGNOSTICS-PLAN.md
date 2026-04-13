# DIAGNOSTICS-PLAN

Implementation plan for [DIAGNOSTICS-SPEC](../specs/DIAGNOSTICS-SPEC.md).

## Phase 1: Single-File Push Diagnostics (P0)

Wire the existing sidecar `workspace/diagnostics` handler through the Rust LSP host to the editor.

### Rust LSP Host

- [x] Create `diagnostics` module in Rust host (`src/diagnostics.rs`)
- [x] Map sidecar `DiagnosticResult` → LSP `Diagnostic` struct
  - Map severity: `"Error"` → 1, `"Warning"` → 2, `"Info"` → 3, `"Hidden"` → 4
  - Map code, message, range
  - Set `source: "forge-csharp"`
- [x] On `textDocument/didOpen` / `textDocument/didChange` / `textDocument/didSave`: request diagnostics from sidecar (background task)
- [x] Send `textDocument/publishDiagnostics` notification with mapped results
- [x] Clear diagnostics on `textDocument/didClose`
- [ ] Add debounce (150ms window) before sidecar request — currently fires immediately
- [x] Rust e2e tests: `test_diagnostics_cleared_on_close`, `test_request_works_after_diagnostic_notification`
- [x] VSCode extension tests: `diagnostics.test.ts` (6 tests — error detection, missing type, clean file, edit cycle, range check, close clears)
- [ ] Full-stack test: open a file with real errors → errors appear in Problems panel (requires sidecar)

### C# Sidecar

- [x] `workspace/diagnostics` handler exists (`CSharpSidecar.HandleDiagnosticsAsync`)
- [x] `WorkspaceManager.GetDiagnosticsAsync` extracts from `SemanticModel.GetDiagnostics()`
- [x] `DiagnosticResult` MessagePack type defined

## Phase 2: Solution-Wide Analysis (P0 — default enabled)

Analyze ALL files in the solution, not just open ones.

### Rust LSP Host

- [x] Read `diagnostics.solution_wide_analysis` from config (default: `true`)
- [x] Read `diagnostics.project_filter` from config (default: empty = all projects)
- [x] On solution load: request solution-wide diagnostics
- [x] Stream diagnostics incrementally (batch by file) to avoid blocking
- [ ] On file change: re-request diagnostics for changed file + dependents
- [x] Advertise `workspaceDiagnostics: true` in server capabilities

### C# Sidecar

- [x] Add `workspace/diagnostics/all` IPC handler
  - Accept `string[]` project filter (empty = all)
  - Iterate all documents in matching projects
  - Return `Dictionary<string, DiagnosticResult[]>` keyed by file path
- [x] Add `GetAllDiagnosticsAsync(string[]? projectFilter, CancellationToken)` to `WorkspaceManager`
  - Iterate `_solution.Projects` filtered by name patterns
  - For each project, iterate `project.Documents`
  - Get `SemanticModel.GetDiagnostics()` for each document
  - Use compilation-level analysis for efficiency
- [ ] Stream results — send partial diagnostics as each project completes

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

## Phase 5: Pull Diagnostics (P1) — DONE

- [x] Implement `textDocument/diagnostic` request handler (LSP 3.17 pull model) — `pull_diagnostics.rs`
- [x] Implement `workspace/diagnostic` request handler — `pull_diagnostics.rs`
- [ ] Support `previousResultId` for incremental updates
- [ ] Report `unchanged` when diagnostics haven't changed

## Phase 5.5: Diagnostic Verification (P0) — DONE

- [x] `didOpen` syncs document text to sidecar via `notify_did_change`
- [x] After solution-wide scan, verification pass re-checks files with errors/warnings
- [x] Verification publishes corrected diagnostics per-file (clears false positives)
- [x] Verification yields between files to avoid starving other sidecar requests
- [x] Test: `test_full_stack_diagnostics_cleared_after_error_fixed` (deterministic)
- [ ] Exponential backoff for persistent errors (1s, 2s, 4s, max 30s)
- [ ] Periodic re-verification for long-running sessions

## Phase 6: Background Analysis Optimization (P1)

- [ ] Priority queue: active doc > visible docs > recent > rest
- [ ] Cancel stale analysis on new edits
- [ ] Incremental re-analysis: only changed file + dependents
- [ ] Memory budget: cap analysis working set
- [ ] Progress reporting via `$/progress` for solution-wide scans

---

## TODO

- [x] **Rust host**: Create `diagnostics` module (`src/diagnostics.rs`)
- [x] **Rust host**: Map sidecar `DiagnosticResult` → LSP `Diagnostic`
- [x] **Rust host**: On `didOpen`/`didChange`/`didSave` → request diagnostics from sidecar (background)
- [x] **Rust host**: Send `textDocument/publishDiagnostics` to editor
- [x] **Rust host**: Clear diagnostics on `textDocument/didClose`
- [ ] **Rust host**: Add debounce (150ms) before sidecar request
- [x] **Rust host**: Read `diagnostics.solution_wide_analysis` from config
- [x] **Rust host**: Read `diagnostics.project_filter` from config
- [x] **Rust host**: On solution load, request solution-wide diagnostics
- [x] **Rust host**: Stream diagnostics incrementally by file
- [x] **Rust host**: `didOpen` syncs text to sidecar via `notify_did_change`
- [x] **Rust host**: Verification pass re-checks files with errors after solution-wide scan
- [ ] **Rust host**: Re-request diagnostics for changed file + dependents
- [x] **Rust host**: Advertise `workspaceDiagnostics: true` in capabilities
- [x] **Rust host**: Implement `textDocument/diagnostic` pull handler (LSP 3.17) — `pull_diagnostics.rs`
- [x] **Rust host**: Implement `workspace/diagnostic` pull handler — `pull_diagnostics.rs`
- [ ] **Rust host**: Support `previousResultId` for incremental pull updates
- [ ] **Rust host**: Priority queue: active > visible > recent > rest
- [ ] **Rust host**: Cancel stale analysis on new edits
- [ ] **Rust host**: Progress reporting via `$/progress` for solution-wide scans
- [x] **C# sidecar**: Add `workspace/diagnostics/all` IPC handler
- [x] **C# sidecar**: Add `GetAllDiagnosticsAsync` to `WorkspaceManager`
- [ ] **C# sidecar**: Enable `CompilationWithAnalyzers.GetAnalyzerDiagnosticsAsync()`
- [ ] **C# sidecar**: Load NuGet analyzer references
- [ ] **C# sidecar**: Load .editorconfig severity overrides
- [ ] **C# sidecar**: IDE0005 (unused usings) detection
- [ ] **C# sidecar**: Map analyzer codes to `codeDescription` URLs
- [ ] **C# sidecar**: Stream partial diagnostics as each project completes
- [ ] **F# sidecar**: `FSharpCheckFileResults.Diagnostics` integration
- [ ] **F# sidecar**: Map F# diagnostic severity to LSP
- [ ] **F# sidecar**: Solution-wide F# analysis via `FSharpChecker`
- [ ] **F# sidecar**: FSharpLint integration
- [ ] **F# sidecar**: FSharp.Analyzers.SDK plugin loading
- [x] **Config**: Add `project_filter: Vec<String>` to `DiagnosticsConfig`
- [ ] **Config**: Add `min_severity: String` to `DiagnosticsConfig`
- [ ] **Config**: Add `max_per_file: u32` to `DiagnosticsConfig`
- [ ] **Config**: Hot-reload via `workspace/didChangeConfiguration`
- [x] **Test**: Rust e2e — didClose sends empty publishDiagnostics
- [x] **Test**: Rust e2e — request() skips diagnostic notifications
- [x] **Test**: VSCode — file with type error shows diagnostics
- [x] **Test**: VSCode — file with missing type shows diagnostics
- [x] **Test**: VSCode — valid file has no error diagnostics
- [x] **Test**: VSCode — fixing an error clears the diagnostic
- [x] **Test**: VSCode — diagnostics have correct severity and range
- [x] **Test**: VSCode — closing a document clears its diagnostics
- [x] **Test**: Full-stack — close/reopen with fixed source clears stale diagnostics
- [ ] **Test**: Full-stack — open file with errors → errors in Problems panel
- [ ] **Test**: Solution-wide scan finds errors in unopened files
- [ ] **Test**: Project filter excludes specified projects
- [ ] **Test**: Sidecar crash recovery preserves last-known diagnostics

## Phase 7: Advanced Analysis

- [ ] Code metrics (cyclomatic complexity)
- [ ] Value tracking / data flow analysis
