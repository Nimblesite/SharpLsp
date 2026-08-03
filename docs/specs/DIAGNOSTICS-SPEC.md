# [DIAG] Diagnostics Specification

SharpLsp MUST surface compiler errors, warnings, and analyzer diagnostics across the solution without reporting stale compilation state.

## [DIAG-ARCHITECTURE] Architecture

SharpLsp uses the LSP 3.17 pull-diagnostics model with workspace refresh.

```
Editor ←→ Rust LSP Host ←→ C#/F# Sidecar (Roslyn / FCS)
  ↑           ↑                    ↑
  Problems    workspace/diagnostic Workspace.RegisterWorkspaceChangedHandler
  window      ←refresh notifs      DocumentDiagnosticsService (per-doc)
              textDocument/        (no eager solution scan — ever)
              diagnostic←pull
```

### [DIAG-ARCHITECTURE-PULL-REFRESH] Pull and Refresh Cycle

SharpLsp MUST NOT push errors during workspace load while NuGet restore, source generators, or cross-project `CompilationReference` resolution is incomplete; doing so can produce phantom CS0246/CS0234 errors.

Instead:

1. **Workspace open**: Rust host opens the workspace in the sidecar. Sidecar runs [DIAG-RESTORE] before creating `MSBuildWorkspace`. Once the workspace is created, the sidecar subscribes to `Workspace.RegisterWorkspaceChangedHandler` and seeds a monotonic `global_state_version: u64`.
2. **Server advertises pull**: capabilities include `diagnosticProvider.workspaceDiagnostics: true` and `interFileDependencies: true`.
3. **Editor pulls**: editor sends `textDocument/diagnostic` (per file) and/or `workspace/diagnostic` (whole workspace) on its own schedule. Each request includes any `previousResultId` it has cached.
4. **Sidecar answers per-document**: for each pull, the sidecar calls `Project.GetCompilationAsync().GetSemanticModel(tree).GetDiagnostics()` (and `CompilationWithAnalyzers` for analyzer diagnostics) for **just the requested document(s)**. Roslyn's lazy compilation transparently forces topological resolution of the requested project's dependencies.
5. **Result identity**: response carries `resultId = "{project_version}:{doc_version}:{global_state_version}"`. If the editor's `previousResultId` matches, the server returns `DiagnosticReport.Unchanged` (per LSP 3.17) and skips re-computation.
6. **Refresh on change**: any sidecar-side `WorkspaceChanged` event (`ProjectAdded`, `ProjectReloaded`, `SolutionChanged`, `DocumentChanged`, restore completion) bumps `global_state_version` and emits a `diagnostics/refresh` IPC notification. Rust host coalesces these via a 2000ms debounced batch (matching Roslyn LSP's `AsyncBatchingWorkQueue`) and sends LSP `workspace/diagnostic/refresh` to the editor. The editor re-pulls — diagnostics converge to truth.

### [DIAG-ARCHITECTURE-EAGER-SCAN] No Eager Solution Scan

The server MUST NOT scan `Solution.Projects` eagerly with `GetCompilationAsync()` during load: consumer projects can compile before dependencies become cached `CompilationReference`s, and source generators or restore can still be incomplete. It also MUST NOT simulate a verification pass by sending unchanged text through `textDocument/didChange`; `WithDocumentText` does not rebuild metadata references or generator state. Pull responses report the current snapshot, and a later `global_state_version` bump causes the editor to re-pull.

### [DIAG-PUSH-GATE] Push Convergence Guarantee

Editors without pull support receive `textDocument/publishDiagnostics` pushes triggered by `didOpen`/`didChange`. Because a push persists until replaced, the Rust host version-gates every push:

1. Each `didOpen`/`didChange`/`didClose` registers a monotonically increasing push generation for the document URI.
2. A completed sidecar fetch publishes only if its generation is still newest; older results are dropped.
3. A failed fetch for the newest generation is retried at 1s intervals with a bounded budget long enough for a sidecar kill and respawn, until it publishes or a newer generation supersedes it. Dropping the fetch could leave the previous publication on screen indefinitely.
4. Generations are never reused after `didClose`, preventing an old in-flight fetch from matching a new document generation.

The last publication for a document MUST reflect its newest known text.

### [DIAG-ARCHITECTURE-SCOPE] Analysis Scope

| Mode | Scope | Default | Use Case |
|------|-------|---------|----------|
| **Solution-wide (pull)** | Editor pulls `workspace/diagnostic`; sidecar answers per project on demand | **Enabled** | Full error visibility without opening files |
| **Open files only** | Editor only pulls `textDocument/diagnostic` for documents it has opened | Optional | Editors that don't issue `workspace/diagnostic` |
| **Per-project filter** | `workspace/diagnostic` partial-result handler restricts to filtered projects | Optional | Focus analysis on active development targets |

Solution-wide analysis is the default. The VS Code extension explicitly drives the workspace pull and renders results in the Problems panel before files are opened.

## [DIAG-CONFIG] Configuration

```toml
# sharplsp.toml
[diagnostics]
# Run Roslyn/FCS analyzers (not just compiler diagnostics)
analyzers_enabled = true

# Answer workspace/diagnostic pulls for the whole solution (default: true).
# When false, the server returns no items for workspace pulls — only
# textDocument/diagnostic pulls (per open file) are answered.
solution_wide_analysis = true

# Filter which projects are returned by workspace/diagnostic pulls
# (glob patterns, empty = all). Per-file pulls are unaffected.
project_filter = []

# Severity threshold — drop diagnostics below this level before returning
# them to the editor. Values: "error", "warning", "info", "hint"
min_severity = "hint"

# Maximum diagnostics per file (0 = unlimited). Applied after severity filtering.
max_per_file = 0

# SharpLsp-owned static analyzers are configured under
# [diagnostics.static_analyzers]. Monorepo-only analyzers also require
# [workspace].repository_kind = "monorepo".

# Refresh debounce in milliseconds. Workspace mutations within this window
# coalesce into one workspace/diagnostic/refresh notification. Default 2000
# matches Microsoft.CodeAnalysis.LanguageServer.
refresh_debounce_ms = 2000

# Run `dotnet restore` on workspace open if project.assets.json is stale.
# Disabling this WILL produce phantom CS0246 for NuGet types until the
# user runs restore manually. Default true.
auto_restore_on_open = true
```

### [DIAG-CONFIG-PROJECT-FILTER] Project Filter

The `project_filter` field accepts glob patterns matched against project names or relative paths:

```toml
[diagnostics]
# Only return diagnostics for these projects in workspace pulls
project_filter = ["MyApp.Core", "MyApp.Api", "MyApp.Tests.*"]
```

When empty (default), every project in the solution is included. Per-document pulls (`textDocument/diagnostic`) are never filtered — the editor asked for that file specifically, so the server always answers.

### [DIAG-CONFIG-RELOAD] Runtime Reconfiguration

Diagnostics settings are hot-reloadable via `workspace/didChangeConfiguration`. Changing `solution_wide_analysis`, `project_filter`, or `min_severity` bumps `global_state_version` and triggers `workspace/diagnostic/refresh` so the editor re-pulls under the new policy.

Static analyzer configuration and its monorepo-only gate are specified by [ANALYZERS-MONOREPO-GATE](DIAGNOSTICS-STATIC-ANALYZERS-SPEC.md#analyzers-monorepo-gate-monorepo-gate).

## [DIAG-CATEGORIES] Diagnostic Categories

### [DIAG-CATEGORIES-COMPILER] Compiler Diagnostics

| Source | C# (Roslyn) | F# (FCS) |
|--------|------------|----------|
| Syntax errors | `CS1001`, `CS1002`, ... | `FS0001`, ... |
| Type errors | `CS0029`, `CS0266`, ... | `FS0001`, ... |
| Missing references | `CS0246`, `CS0103`, ... | `FS0039`, ... |
| Nullable warnings | `CS8600`–`CS8798` | N/A (F# uses `option`) |

### [DIAG-CATEGORIES-ANALYZER] Analyzer Diagnostics

| Source | API | Examples |
|--------|-----|----------|
| Built-in Roslyn analyzers | `DiagnosticAnalyzer` framework | IDE0001–IDE0090, CA1000–CA2000 |
| .editorconfig rules | `.editorconfig` → analyzer severity | Code style enforcement |
| Third-party NuGet analyzers | NuGet `<Analyzer>` references | StyleCop, SonarAnalyzer, etc. |
| FSharp.Analyzers.SDK | Plugin-based analyzers | Community F# analyzers |
| SharpLsp static analyzers | Solution-wide symbol/reference index | Monorepo-only unused public C#/F# code elements |

Monorepo-only unused-public-code behavior is specified by [ANALYZERS-UNUSED-PUBLIC](DIAGNOSTICS-STATIC-ANALYZERS-SPEC.md#analyzers-unused-public-unused-public-code-elements).

### [DIAG-CATEGORIES-LIVE] Live Squiggles

Live diagnostics flow through [DIAG-ARCHITECTURE-PULL-REFRESH]:

- **On document change**: editor's pull-diagnostic client sends `textDocument/diagnostic` after its own debounce. Sidecar's `LspWorkspaceManager` change handler bumps `global_state_version`, host emits debounced `workspace/diagnostic/refresh`, editor re-pulls anything else that may have been affected by inter-file dependencies.
- **On project change**: sidecar's `Workspace.RegisterWorkspaceChangedHandler` fires for `ProjectReloaded` / `ProjectAdded`. Sidecar bumps `global_state_version` and signals `diagnostics/refresh`.
- **On workspace load**: NO eager analysis. After NuGet restore + workspace open complete, the sidecar fires `diagnostics/refresh` once. The editor pulls — that pull is the first diagnostic computation, and it is correct because restore has finished.

## [DIAG-LSP] LSP Protocol

### [DIAG-LSP-CAPABILITIES] Server Capabilities

```json
{
  "diagnosticProvider": {
    "interFileDependencies": true,
    "workspaceDiagnostics": true,
    "identifier": "sharplsp"
  }
}
```

`workspaceDiagnostics: true` is mandatory — it is how the editor knows it can ask SharpLsp for solution-wide errors. `identifier: "sharplsp"` lets the editor distinguish SharpLsp's diagnostics from other servers.

### [DIAG-LSP-PULL] Pull Model (`textDocument/diagnostic`, `workspace/diagnostic`)

LSP 3.17 pull diagnostics is the **primary** model. The server returns whatever Roslyn currently knows for the requested document(s); it never preemptively asserts.

Per-document request:

```jsonc
// → request
{
  "method": "textDocument/diagnostic",
  "params": {
    "textDocument": { "uri": "file:///path/to/File.cs" },
    "previousResultId": "p:42|d:7|g:118"  // optional, from a prior response
  }
}

// ← response (changed)
{
  "result": {
    "kind": "full",
    "resultId": "p:42|d:7|g:119",
    "items": [
      {
        "range": { "start": { "line": 10, "character": 4 }, "end": { "line": 10, "character": 20 } },
        "severity": 1,
        "code": "CS0029",
        "source": "sharplsp-csharp",
        "message": "Cannot implicitly convert type 'string' to 'int'"
      }
    ]
  }
}

// ← response (unchanged — server skipped recomputation)
{
  "result": { "kind": "unchanged", "resultId": "p:42|d:7|g:118" }
}
```

`resultId` format is `p:{project_version}|d:{doc_version}|g:{global_state_version}`. When the editor's `previousResultId` matches the current key for that document, the server returns `{ kind: "unchanged" }` (per LSP 3.17 §10.6.1) and skips both the IPC round-trip and the Roslyn semantic analysis.

Workspace request (`workspace/diagnostic`) is supported with partial-result streaming so large solutions don't block on a single response.

### [DIAG-LSP-REFRESH] Refresh Notifications (`workspace/diagnostic/refresh`)

When sidecar state changes invalidate cached diagnostics, the host sends:

```json
{ "method": "workspace/diagnostic/refresh" }
```

This tells the editor to discard its cached `previousResultId`s and re-pull. Refreshes are **debounced 2000ms** (matching `Microsoft.CodeAnalysis.LanguageServer`'s `AsyncBatchingWorkQueue`) — multiple workspace events within the debounce window collapse into one refresh.

Refresh triggers (sidecar → host IPC notification `diagnostics/refresh` carrying the new `global_state_version`):

- `WorkspaceChangeKind.ProjectAdded`, `ProjectReloaded`, `ProjectRemoved`, `SolutionAdded`, `SolutionChanged`, `SolutionReloaded`
- NuGet restore completion
- Source generator output updated (`Compilation.WithReferences` / generator-driver state change)
- `.editorconfig` file change inside the solution
- Analyzer reference added/removed

### [DIAG-LSP-PUSH] Push Model (`textDocument/publishDiagnostics`)

Push exists only as a fallback for editors that do not advertise `textDocument.diagnostic.dynamicRegistration` (i.e. older LSP clients that predate 3.17 pull). When push is the only option, the host treats every refresh trigger as a per-document publish, reusing the same per-document analysis pipeline.

SharpLsp's VS Code extension always negotiates pull. Push fallback exists for editor coverage (some Vim plugins, older Eclipse JDT-LSP-style clients), not as the canonical path.

### [DIAG-LSP-SEVERITY] Severity Mapping

| Roslyn Severity | LSP DiagnosticSeverity |
|-----------------|----------------------|
| `Error` | 1 (Error) |
| `Warning` | 2 (Warning) |
| `Info` | 3 (Information) |
| `Hidden` | 4 (Hint) |

## [DIAG-IPC] Sidecar IPC Messages

### [DIAG-IPC-DOCUMENT-REQUEST] Request: `workspace/diagnostics`

Per-document pull. Called by the Rust host in response to LSP `textDocument/diagnostic`.

Payload (MessagePack):

```csharp
[MessagePackObject]
class DiagnosticsRequest
{
    [Key(0)] string FilePath;
    [Key(1)] string? PreviousResultId;   // sidecar can short-circuit if unchanged
}
```

Response: `DiagnosticResult[]` (see [DIAG-IPC-DOCUMENT-RESPONSE]) plus `ResultId` and a `Changed` flag. When `Changed = false`, the items array is empty and the host returns `{ kind: "unchanged" }` to the editor.

### [DIAG-IPC-DOCUMENT-RESPONSE] Response: `DiagnosticResult[]`

```csharp
[MessagePackObject]
class DiagnosticResult
{
    [Key(0)] string FilePath;
    [Key(1)] int StartLine;
    [Key(2)] int StartCharacter;
    [Key(3)] int EndLine;
    [Key(4)] int EndCharacter;
    [Key(5)] string Message;
    [Key(6)] string Severity;  // "Error", "Warning", "Info", "Hidden"
    [Key(7)] string Code;      // e.g. "CS0029", "IDE0001"
}
```

### [DIAG-IPC-WORKSPACE-PULL] Workspace Pull: `workspace/diagnostics/pull`

Called by the Rust host in response to LSP `workspace/diagnostic`. The sidecar streams per-document results (one `WorkspaceDocumentDiagnosticReport` per document) so the editor sees results progressively. Results omit unchanged documents (matching `DiagnosticReport.Unchanged` semantics).

The legacy `workspace/diagnostics/all` bulk RPC MUST NOT be restored; workspace-wide analysis happens lazily through per-document pulls as specified by [DIAG-ARCHITECTURE-EAGER-SCAN].

### [DIAG-IPC-REFRESH] Notification: `diagnostics/refresh`

Sidecar → host notification fired when any input invalidates cached diagnostics. Payload:

```csharp
[MessagePackObject]
class RefreshNotification
{
    [Key(0)] ulong GlobalStateVersion;
    [Key(1)] string[] AffectedProjectIds;   // empty = whole workspace
}
```

The host coalesces refreshes via a 2000ms debounced batch and emits LSP `workspace/diagnostic/refresh`.

### [DIAG-IPC-INITIALIZED] Notification: `workspace/initializationComplete`

Sidecar → host notification fired exactly once after NuGet restore + `MSBuildWorkspace.OpenSolutionAsync` complete. The host forwards as the LSP custom notification `workspace/projectInitializationComplete` (matching `Microsoft.CodeAnalysis.LanguageServer`'s contract). Editors use this to dismiss "Loading projects…" UI.

## [DIAG-RESTORE] NuGet Restore Gate

Before workspace creation, SharpLsp applies this restore gate:

1. Before calling `MSBuildWorkspace.OpenSolutionAsync`, the sidecar inspects each project's `obj/project.assets.json`.
2. If `assets.json` is missing, older than the `.csproj`, or its `PackageReference` set differs from the `.csproj`, the sidecar shells `dotnet restore <path>` via a `DotnetCliHelper` equivalent. Restore progress is reported via LSP `$/progress` (work-done token established at workspace open).
3. Only after restore completes does the sidecar create `MSBuildWorkspace`.
4. Restore completion bumps `global_state_version` and triggers an initial `diagnostics/refresh`.

The gate is mandatory because unresolved `<PackageReference>` items can produce CS0246/CS0234 diagnostics on the first pull.

## [DIAG-PERFORMANCE] Performance Targets

| Metric | Target |
|--------|--------|
| Per-document pull (cached) | <5ms (returns `unchanged`) |
| Per-document pull (cold) | <200ms p50, <500ms p95 |
| Workspace pull, partial result for first document | <500ms after restore completes |
| Workspace pull, full result for 50-project solution | <10s after restore completes |
| Refresh debounce window | 2000ms (matches Roslyn LSP) |
| NuGet restore (cached / `assets.json` valid) | <100ms (gate skipped) |
| NuGet restore (cold) | bounded only by `dotnet restore` itself; surface via `$/progress` |
| Memory overhead (per-document caching) | <200MB additional for 50-project solution |

## [DIAG-SCOPE] Supported Scope

| Capability | Priority | Phase |
|------------|----------|-------|
| Compiler errors and warnings | P0 | Two |
| Roslyn analyzer diagnostics | P0 | Two |
| Solution-wide error analysis, default enabled | P0 | Two |
| Unused using/open detection | P0 | Two |
| Monorepo-only unused public code detection | P0 | Four |
| Nullable reference analysis | P1 | Three |
| `.editorconfig` code-style enforcement | P1 | Three |
| Third-party NuGet analyzers | P1 | Four |
| FSharp.Analyzers.SDK support | P1 | Four |
| Code metrics | P2 | Four |
| Value tracking and data flow | P2 | Four |
| IL inspection | P3 | Five |
| Heap allocation viewing | P3 | Five |

## [DIAG-ANALYSIS] Background Analysis Strategy

### [DIAG-ANALYSIS-PULL] Pull-Driven Analysis

There is no background scan thread. Roslyn analysis happens only when the editor pulls:

- **Lazy compilation**: `Project.GetCompilationAsync()` is invoked on demand for the project of the document being pulled. Roslyn topologically resolves and caches dependency compilations as `CompilationReference`s. Subsequent pulls within the same `Solution` snapshot reuse the cache — the second pull on any file in the same project completes in milliseconds.
- **Caching by `resultId`**: per [DIAG-LSP-PULL], repeat pulls for unchanged documents return `{ kind: "unchanged" }` without re-running Roslyn. The cache key includes `global_state_version`, so any workspace mutation invalidates the entire cache atomically.
- **Workspace event subscription**: the sidecar's `Workspace.RegisterWorkspaceChangedHandler` is the only active background work. It mutates `global_state_version` and emits `diagnostics/refresh`. It does not analyze anything itself.

### [DIAG-ANALYSIS-CANCELLATION] Cancellation

- The Rust host cancels in-flight per-document IPC requests when the editor sends a fresh pull for the same document with a higher `previousResultId`-implied version (or a different `previousResultId`).
- The sidecar passes the IPC `CancellationToken` straight into `GetSemanticModelAsync` / `GetAnalyzerSemanticDiagnosticsAsync`.
- A `WorkspaceChanged` event mid-pull does not cancel the pull. The pull completes against its snapshot, returns its `resultId`, and the bumped `global_state_version` causes the next refresh to invalidate it. This matches `AbstractPullDiagnosticHandler`'s snapshot-isolation behavior in `dotnet/roslyn`.

### [DIAG-ANALYSIS-INCREMENTAL] Incremental Updates

When a file changes:

- The host updates its VFS, sends `textDocument/didChange` IPC to the sidecar (which calls `_solution.WithDocumentText(...)`), and the sidecar emits `diagnostics/refresh` carrying only the affected project's IDs in `AffectedProjectIds`.
- The host's debounced refresh queue collapses bursts; the LSP `workspace/diagnostic/refresh` notification fires once per debounce window.
- The editor re-pulls. Files unaffected by the change return `{ kind: "unchanged" }` cheaply because their `resultId` (which incorporates project version) hasn't moved.

## [DIAG-TRUTH] Truth Guarantees

### [DIAG-TRUTH-GUARANTEES] Guarantees

- If `dotnet build` succeeds with zero errors against the same source, the next pull (after refresh debounce + restore completion) returns zero Error-severity diagnostics.
- A diagnostic in the Problems panel corresponds to a real Roslyn compiler or analyzer diagnostic from the current `Solution` snapshot.
- A workspace mutation that changes a file's diagnostics produces an LSP `workspace/diagnostic/refresh` within 2000ms (the debounce window). Editors converge to truth one pull cycle after that.

### [DIAG-TRUTH-LIMITS] Limits

- The first pull during workspace load may be incomplete. The response reflects the current snapshot; after [DIAG-RESTORE], project-reference and NuGet types are resolved, but source-generator output may still be missing.
- The remedy for "incomplete but not wrong" is `workspace/diagnostic/refresh`. Generator output materializing fires a `WorkspaceChanged` event → refresh → re-pull → complete result.
