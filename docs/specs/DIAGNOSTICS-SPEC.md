# DIAGNOSTICS-SPEC

Diagnostics are the core feedback loop for developers. Forge must surface all compiler errors, warnings, and analyzer diagnostics across the entire solution in real-time, matching Visual Studio's Solution-Wide Error Analysis (SWEA) from day one — **without ever lying about compilation state**.

## 1. Architecture

Forge uses the **LSP 3.17 pull-diagnostics model with workspace refresh**, mirroring `Microsoft.CodeAnalysis.LanguageServer` (the engine behind C# Dev Kit). This is the only architecture that produces correct diagnostics during workspace load.

```
Editor ←→ Rust LSP Host ←→ C#/F# Sidecar (Roslyn / FCS)
  ↑           ↑                    ↑
  Problems    workspace/diagnostic Workspace.RegisterWorkspaceChangedHandler
  window      ←refresh notifs      DocumentDiagnosticsService (per-doc)
              textDocument/        (no eager solution scan — ever)
              diagnostic←pull
```

### 1.1 The Pull + Refresh Cycle

**Forge never proactively asserts diagnostics.** It does not push errors during workspace load, because at that moment Roslyn cannot tell the truth — NuGet may be restoring, source generators are lazy, cross-project `CompilationReference`s are still resolving. Pushing during this window produces phantom CS0246/CS0234 errors that contradict `dotnet build`. Forge does not lie.

Instead:

1. **Workspace open**: Rust host opens the workspace in the sidecar. Sidecar runs the NuGet restore gate (see §6) BEFORE creating `MSBuildWorkspace`. Once the workspace is created, the sidecar subscribes to `Workspace.RegisterWorkspaceChangedHandler` and seeds a monotonic `global_state_version: u64`.
2. **Server advertises pull**: capabilities include `diagnosticProvider.workspaceDiagnostics: true` and `interFileDependencies: true`.
3. **Editor pulls**: editor sends `textDocument/diagnostic` (per file) and/or `workspace/diagnostic` (whole workspace) on its own schedule. Each request includes any `previousResultId` it has cached.
4. **Sidecar answers per-document**: for each pull, the sidecar calls `Project.GetCompilationAsync().GetSemanticModel(tree).GetDiagnostics()` (and `CompilationWithAnalyzers` for analyzer diagnostics) for **just the requested document(s)**. Roslyn's lazy compilation transparently forces topological resolution of the requested project's dependencies.
5. **Result identity**: response carries `resultId = "{project_version}:{doc_version}:{global_state_version}"`. If the editor's `previousResultId` matches, the server returns `DiagnosticReport.Unchanged` (per LSP 3.17) and skips re-computation.
6. **Refresh on change**: any sidecar-side `WorkspaceChanged` event (`ProjectAdded`, `ProjectReloaded`, `SolutionChanged`, `DocumentChanged`, restore completion) bumps `global_state_version` and emits a `diagnostics/refresh` IPC notification. Rust host coalesces these via a 2000ms debounced batch (matching Roslyn LSP's `AsyncBatchingWorkQueue`) and sends LSP `workspace/diagnostic/refresh` to the editor. The editor re-pulls — diagnostics converge to truth.

This is the **only** way to give correct diagnostics during multi-second workspace loads. OmniSharp (event-driven push) and Roslyn LSP (pull + refresh) both refuse to assert correctness at any single instant; they converge via invalidation. Forge does the same.

### 1.2 Why no eager solution scan

Earlier versions of this spec described a one-shot solution-wide scan on workspace load, followed by a "verification pass" that re-checked files with errors. **Both have been removed.** They are incompatible with not lying:

- The eager scan iterates `Solution.Projects` and calls `GetCompilationAsync()` on each. The first compilation a consumer project produces — before its dependencies have been cached as `CompilationReference`s — is missing types and emits phantom CS0246s. Topological iteration only partially mitigates this; source generators and NuGet restore still produce wrong-then-right state transitions during load.
- The verification pass tried to repair stale diagnostics by sending `textDocument/didChange` with the same disk text and re-fetching. Roslyn's `WithDocumentText` creates a new immutable `Solution` snapshot, but it does not re-run source generators, re-resolve NuGet, or rebuild metadata references — the underlying compilation is still incomplete, so the same phantom errors come back. It was a band-aid on the wrong premise.

The pull model removes the failure mode entirely: there is no moment at which Forge proactively claims a file has errors. The editor asks; Forge answers with whatever Roslyn currently knows. When Roslyn learns more, the `global_state_version` bumps and the editor re-asks.

### 1.3 Analysis Scope

| Mode | Scope | Default | Use Case |
|------|-------|---------|----------|
| **Solution-wide (pull)** | Editor pulls `workspace/diagnostic`; sidecar answers per project on demand | **Enabled** | Full error visibility without opening files |
| **Open files only** | Editor only pulls `textDocument/diagnostic` for documents it has opened | Optional | Editors that don't issue `workspace/diagnostic` |
| **Per-project filter** | `workspace/diagnostic` partial-result handler restricts to filtered projects | Optional | Focus analysis on active development targets |

Solution-wide analysis is the default because developers need to see errors **everywhere**. The C# Dev Kit limitation is not that it lacks SWEA semantically — it serves `workspace/diagnostic` — but that VS Code's UI doesn't surface workspace diagnostics until the file is opened. Forge's VS Code extension explicitly drives the workspace pull and renders results in the Problems panel before files are opened. This is the SWEA win.

## 2. Configuration

```toml
# forge.toml
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

# Refresh debounce in milliseconds. Workspace mutations within this window
# coalesce into one workspace/diagnostic/refresh notification. Default 2000
# matches Microsoft.CodeAnalysis.LanguageServer.
refresh_debounce_ms = 2000

# Run `dotnet restore` on workspace open if project.assets.json is stale.
# Disabling this WILL produce phantom CS0246 for NuGet types until the
# user runs restore manually. Default true.
auto_restore_on_open = true
```

### 2.1 Project Filter

The `project_filter` field accepts glob patterns matched against project names or relative paths:

```toml
[diagnostics]
# Only return diagnostics for these projects in workspace pulls
project_filter = ["MyApp.Core", "MyApp.Api", "MyApp.Tests.*"]
```

When empty (default), every project in the solution is included. Per-document pulls (`textDocument/diagnostic`) are never filtered — the editor asked for that file specifically, so the server always answers.

### 2.2 Runtime Reconfiguration

Diagnostics settings are hot-reloadable via `workspace/didChangeConfiguration`. Changing `solution_wide_analysis`, `project_filter`, or `min_severity` bumps `global_state_version` and triggers `workspace/diagnostic/refresh` so the editor re-pulls under the new policy.

## 3. Diagnostic Categories

### 3.1 Compiler Diagnostics (P0)

| Source | C# (Roslyn) | F# (FCS) |
|--------|------------|----------|
| Syntax errors | `CS1001`, `CS1002`, ... | `FS0001`, ... |
| Type errors | `CS0029`, `CS0266`, ... | `FS0001`, ... |
| Missing references | `CS0246`, `CS0103`, ... | `FS0039`, ... |
| Nullable warnings | `CS8600`–`CS8798` | N/A (F# uses `option`) |

### 3.2 Analyzer Diagnostics (P0)

| Source | API | Examples |
|--------|-----|----------|
| Built-in Roslyn analyzers | `DiagnosticAnalyzer` framework | IDE0001–IDE0090, CA1000–CA2000 |
| .editorconfig rules | `.editorconfig` → analyzer severity | Code style enforcement |
| Third-party NuGet analyzers | NuGet `<Analyzer>` references | StyleCop, SonarAnalyzer, etc. |
| FSharp.Analyzers.SDK | Plugin-based analyzers | Community F# analyzers |

### 3.3 Live Squiggles (P0)

Live diagnostics flow through the **pull + refresh cycle** described in §1.1:

- **On document change**: editor's pull-diagnostic client sends `textDocument/diagnostic` after its own debounce. Sidecar's `LspWorkspaceManager` change handler bumps `global_state_version`, host emits debounced `workspace/diagnostic/refresh`, editor re-pulls anything else that may have been affected by inter-file dependencies.
- **On project change**: sidecar's `Workspace.RegisterWorkspaceChangedHandler` fires for `ProjectReloaded` / `ProjectAdded`. Sidecar bumps `global_state_version` and signals `diagnostics/refresh`.
- **On workspace load**: NO eager analysis. After NuGet restore + workspace open complete, the sidecar fires `diagnostics/refresh` once. The editor pulls — that pull is the first diagnostic computation, and it is correct because restore has finished.

## 4. LSP Protocol

### 4.1 Server Capabilities

```json
{
  "diagnosticProvider": {
    "interFileDependencies": true,
    "workspaceDiagnostics": true,
    "identifier": "forge"
  }
}
```

`workspaceDiagnostics: true` is mandatory — it is how the editor knows it can ask Forge for solution-wide errors. `identifier: "forge"` lets the editor distinguish Forge's diagnostics from other servers.

### 4.2 Pull Model (PRIMARY: `textDocument/diagnostic`, `workspace/diagnostic`)

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
        "source": "forge-csharp",
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

### 4.3 Refresh Notifications (`workspace/diagnostic/refresh`)

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

### 4.4 Push Model (FALLBACK: `textDocument/publishDiagnostics`)

Push exists only as a fallback for editors that do not advertise `textDocument.diagnostic.dynamicRegistration` (i.e. older LSP clients that predate 3.17 pull). When push is the only option, the host treats every refresh trigger as a per-document publish, reusing the same per-document analysis pipeline.

Forge's VS Code extension always negotiates pull. Push fallback exists for editor coverage (some Vim plugins, older Eclipse JDT-LSP-style clients), not as the canonical path.

### 4.4 Severity Mapping

| Roslyn Severity | LSP DiagnosticSeverity |
|-----------------|----------------------|
| `Error` | 1 (Error) |
| `Warning` | 2 (Warning) |
| `Info` | 3 (Information) |
| `Hidden` | 4 (Hint) |

## 5. Sidecar IPC Messages

### 5.1 Request: `workspace/diagnostics`

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

Response: `DiagnosticResult[]` (see §5.2) plus `ResultId` and a `Changed` flag. When `Changed = false`, the items array is empty and the host returns `{ kind: "unchanged" }` to the editor.

### 5.2 Response: `DiagnosticResult[]`

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

### 5.3 Workspace Pull: `workspace/diagnostics/pull`

Called by the Rust host in response to LSP `workspace/diagnostic`. The sidecar streams per-document results (one `WorkspaceDocumentDiagnosticReport` per document) so the editor sees results progressively. Results omit unchanged documents (matching `DiagnosticReport.Unchanged` semantics).

The legacy `workspace/diagnostics/all` bulk RPC has been **removed**. It eagerly iterated every project and ran `GetCompilationAsync` synchronously, producing the phantom CS0246s described in §1.2. There is no replacement — workspace-wide analysis happens lazily via per-document pulls.

### 5.4 Notification: `diagnostics/refresh`

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

### 5.5 Notification: `workspace/initializationComplete`

Sidecar → host notification fired exactly once after NuGet restore + `MSBuildWorkspace.OpenSolutionAsync` complete. The host forwards as the LSP custom notification `workspace/projectInitializationComplete` (matching `Microsoft.CodeAnalysis.LanguageServer`'s contract). Editors use this to dismiss "Loading projects…" UI.

## 6. NuGet Restore Gate

Phantom CS0246 for NuGet types is the most common false-positive class. Forge mirrors `Microsoft.CodeAnalysis.LanguageServer.HostWorkspace.ProjectDependencyHelper`:

1. Before calling `MSBuildWorkspace.OpenSolutionAsync`, the sidecar inspects each project's `obj/project.assets.json`.
2. If `assets.json` is missing, older than the `.csproj`, or its `PackageReference` set differs from the `.csproj`, the sidecar shells `dotnet restore <path>` via a `DotnetCliHelper` equivalent. Restore progress is reported via LSP `$/progress` (work-done token established at workspace open).
3. Only after restore completes does the sidecar create `MSBuildWorkspace`.
4. Restore completion bumps `global_state_version` and triggers an initial `diagnostics/refresh`.

Without this gate, the editor's first pull happens against a workspace with unresolved `<PackageReference>` items, producing CS0246/CS0234 for every NuGet type. The gate is non-optional — `dotnet restore` may take several seconds, but the alternative is a lie.

## 7. Performance Targets

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

## 8. Competitive Analysis

**Legend:** VS = Visual Studio, CDK = C# Dev Kit, R = Rider. ✓ = incumbent has this feature.

| Feature | VS | CDK | R | Forge | Priority | Phase |
|---|---|---|---|---|---|---|
| Compiler errors and warnings | ✓ | ✓ | ✓ | **P0** | P0 | 2 |
| Roslyn analyzer diagnostics | ✓ | ✓ | ✓ | **P0** | P0 | 2 |
| Solution-wide error analysis (SWEA) | ✓ | ✗ | ✓ | **P0 (default on)** | P0 | 2 |
| Unused using/open detection | ✓ | ✓ | ✓ | **P0** | P0 | 2 |
| Nullable reference analysis | ✓ | ✓ | ✓ | **P1** | P1 | 3 |
| Code style enforcement (.editorconfig) | ✓ | ✓ | ✓ | **P1** | P1 | 3 |
| Third-party NuGet analyzers | ✓ | ✓ | ✓ | **P1** | P1 | 4 |
| FSharp.Analyzers.SDK support | ✗ | ✗ | ✗ | **P1** | P1 | 4 |
| Code metrics (cyclomatic complexity) | ✓ | ✗ | ✓ | **P2** | P2 | 4 |
| Value tracking / data flow | ✓ | ✗ | ✓ | **P2** | P2 | 4 |
| IL inspection / viewer | ✓ | ✗ | ✓ | **P3** | P3 | 5 |
| Heap allocation viewer | ✗ | ✗ | ✓ | **P3** | P3 | 5 |

Key differentiators:

- **SWEA surfaced in Problems panel without opening files.** C# Dev Kit's underlying server (`Microsoft.CodeAnalysis.LanguageServer`) implements `workspace/diagnostic` correctly — the gap is the VS Code extension UX, which doesn't drive the workspace pull. Forge's extension does, so SWEA actually works for the user.
- **Pull + refresh from day one.** Forge ships LSP 3.17 pull diagnostics as the primary path. OmniSharp uses event-driven push (correct semantics, but every editor sees the convergence flicker). Forge uses pull, so editors with cached `previousResultId`s avoid the flicker entirely.
- **No phantom errors.** Forge's NuGet restore gate (§6) and pull-only model (§1.1) eliminate the false-positive class that haunts every other LSP-based .NET tool.

## 9. Background Analysis Strategy

### 9.1 Pull-driven, lazy by construction

There is no background scan thread. Roslyn analysis happens **only when the editor pulls**. The `Microsoft.CodeAnalysis.LanguageServer` model proves this is sufficient: editors pull aggressively for visible documents, lazily for the rest, and the server amortizes computation across pulls. Adding a background scanner on top would either duplicate work or race with pulls.

What replaces the old "background scan":

- **Lazy compilation**: `Project.GetCompilationAsync()` is invoked on demand for the project of the document being pulled. Roslyn topologically resolves and caches dependency compilations as `CompilationReference`s. Subsequent pulls within the same `Solution` snapshot reuse the cache — the second pull on any file in the same project completes in milliseconds.
- **Caching by `resultId`**: per §4.2, repeat pulls for unchanged documents return `{ kind: "unchanged" }` without re-running Roslyn. The cache key includes `global_state_version`, so any workspace mutation invalidates the entire cache atomically.
- **Workspace event subscription**: the sidecar's `Workspace.RegisterWorkspaceChangedHandler` is the only active background work. It mutates `global_state_version` and emits `diagnostics/refresh`. It does not analyze anything itself.

### 9.2 Cancellation

- The Rust host cancels in-flight per-document IPC requests when the editor sends a fresh pull for the same document with a higher `previousResultId`-implied version (or a different `previousResultId`).
- The sidecar passes the IPC `CancellationToken` straight into `GetSemanticModelAsync` / `GetAnalyzerSemanticDiagnosticsAsync`.
- A `WorkspaceChanged` event mid-pull does not cancel the pull. The pull completes against its snapshot, returns its `resultId`, and the bumped `global_state_version` causes the next refresh to invalidate it. This matches `AbstractPullDiagnosticHandler`'s snapshot-isolation behavior in `dotnet/roslyn`.

### 9.3 Incremental updates

When a file changes:

- The host updates its VFS, sends `textDocument/didChange` IPC to the sidecar (which calls `_solution.WithDocumentText(...)`), and the sidecar emits `diagnostics/refresh` carrying only the affected project's IDs in `AffectedProjectIds`.
- The host's debounced refresh queue collapses bursts; the LSP `workspace/diagnostic/refresh` notification fires once per debounce window.
- The editor re-pulls. Files unaffected by the change return `{ kind: "unchanged" }` cheaply because their `resultId` (which incorporates project version) hasn't moved.

Roslyn's `Compilation` is immutable — there is no incremental analyzer state to manage on our side. Roslyn handles fork-and-cache internally.

## 10. Truth Guarantees (No False Positives)

**Forge does not lie.** Every diagnostic shown to the developer must reflect Roslyn's current best understanding of the workspace.

### 10.1 What we promise

- If `dotnet build` succeeds with zero errors against the same source, the next pull (after refresh debounce + restore completion) returns zero Error-severity diagnostics.
- A diagnostic in the Problems panel corresponds to a real Roslyn compiler or analyzer diagnostic from the current `Solution` snapshot.
- A workspace mutation that changes a file's diagnostics produces an LSP `workspace/diagnostic/refresh` within 2000ms (the debounce window). Editors converge to truth one pull cycle after that.

### 10.2 What we do not promise

- We do not promise that the **first** pull during workspace load is complete. NuGet restore may still be running for some projects; source generators may not yet have produced output. The pull will return whatever Roslyn knows at that instant — which after the §6 restore gate is correct for project-reference and NuGet types, but may be missing generator output.
- The remedy for "incomplete but not wrong" is `workspace/diagnostic/refresh`. Generator output materializing fires a `WorkspaceChanged` event → refresh → re-pull → complete result.

### 10.3 Why the previous "verification pass" is gone

Earlier revisions of this spec mandated a low-priority verification pass that re-checked files with errors and cleared false positives. **It has been deleted.** The pass was based on a wrong premise: it assumed re-sending `textDocument/didChange` with the same disk text would cause Roslyn to re-resolve missing references. It does not — `Solution.WithDocumentText` invalidates only the per-document syntax tree, not the metadata-reference graph or the generator-driver state. The pass therefore re-fetched the same phantom errors. The pull + refresh model removes the pass's reason to exist: Forge no longer asserts diagnostics until the editor pulls, so there is nothing stale to repair.
