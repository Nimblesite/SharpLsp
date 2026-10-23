# [DIAG-SPEC] Diagnostics Specification

SharpLsp MUST surface compiler errors, warnings, and analyzer diagnostics across the solution without reporting stale compilation state.

## [DIAG-ARCHITECTURE] Architecture

SharpLsp uses LSP 3.17 pull diagnostics: the Rust host answers editor pulls through Roslyn/FCS sidecars, and sidecar workspace changes trigger `workspace/diagnostic/refresh`.

Implementations: [diagnostics.rs](../../src/sharplsp/src/diagnostics.rs), [pull_diagnostics.rs](../../src/sharplsp/src/pull_diagnostics.rs), and the [full-stack diagnostics tests](../../src/sharplsp/tests/e2e_modules/diagnostics_full_stack.rs).

### [DIAG-ARCHITECTURE-PULL-REFRESH] Pull and Refresh Cycle

SharpLsp MUST NOT push errors during workspace load while NuGet restore, source generators, or cross-project `CompilationReference` resolution is incomplete; doing so can produce phantom CS0246/CS0234 errors.

Instead:

1. **Workspace open**: Rust host opens the workspace in the sidecar. Sidecar runs [DIAG-RESTORE] before creating `MSBuildWorkspace`. Once the workspace is created, the sidecar subscribes to `Workspace.RegisterWorkspaceChangedHandler` and seeds a monotonic `global_state_version: u64`.
2. **Server advertises pull**: capabilities include `diagnosticProvider.workspaceDiagnostics: true` and `interFileDependencies: true`.
3. **Editor pulls**: editor sends `textDocument/diagnostic` (per file) and/or `workspace/diagnostic` (whole workspace) on its own schedule. A request may carry the opaque `previousResultId` returned earlier; the SharpLsp extension MUST NOT retain diagnostic results.
4. **Host queries salsa**: the Rust host evaluates the per-document diagnostic salsa query. On a memoized hit it reuses the query value; on a miss it asks the sidecar to call `Project.GetCompilationAsync().GetSemanticModel(tree).GetDiagnostics()` and `CompilationWithAnalyzers` for only the requested document, then supplies the result to salsa.
5. **Result identity**: response carries `resultId = "{project_version}:{doc_version}:{global_state_version}"`. If `previousResultId` matches the current salsa query identity, the host returns `DiagnosticReport.Unchanged` and skips IPC and semantic analysis.
6. **Refresh on change**: any sidecar-side `WorkspaceChanged` event (`ProjectAdded`, `ProjectReloaded`, `SolutionChanged`, `DocumentChanged`, restore completion) bumps `global_state_version` and emits `diagnostics/refresh`. The Rust host updates the corresponding salsa inputs, coalesces refreshes for 2000ms, and sends LSP `workspace/diagnostic/refresh`; the editor then re-pulls.

### [DIAG-ARCHITECTURE-SALSA] Salsa Ownership

Rust-host salsa is the only diagnostic memoization mechanism. Its inputs include document text and version, project version, `global_state_version`, and effective diagnostic configuration; its tracked query returns the per-document diagnostic report and result identity.

The extension and sidecars may retain protocol, UI, compiler-workspace, and process state, but MUST NOT retain diagnostic arrays, result lookups, compilation-result memoization, or other client-side/sidecar-local caches. A sidecar computes a document on a salsa miss and returns the value without storing a SharpLsp cache. Workspace and configuration changes update salsa inputs, and salsa dependency tracking performs invalidation; no LRU, map-backed memo table, or parallel ad-hoc cache is permitted.

### [DIAG-ARCHITECTURE-EAGER-SCAN] No Eager Solution Scan

The server MUST NOT scan `Solution.Projects` eagerly with `GetCompilationAsync()` during load: consumer projects can compile before dependency `CompilationReference`s are ready, and source generators or restore can still be incomplete. It also MUST NOT simulate a verification pass by sending unchanged text through `textDocument/didChange`; `WithDocumentText` does not rebuild metadata references or generator state. Pull responses report the current snapshot, and a later `global_state_version` bump causes the editor to re-pull.

### [DIAG-PUSH-GATE] Push Convergence Guarantee

Editors without pull support receive `textDocument/publishDiagnostics` pushes triggered by `didOpen`/`didChange`. Because a push persists until replaced, the Rust host version-gates every push:

1. Each `didOpen`/`didChange`/`didClose` registers a monotonically increasing push generation for the document URI.
2. A completed sidecar fetch publishes only if its generation is still newest; older results are dropped.
3. A failed fetch for the newest generation is retried at 1s intervals for up to 120 attempts, until it publishes or a newer generation supersedes it. Dropping the fetch could leave the previous publication on screen indefinitely.
4. A *provisional* set is republished on the same 1s cadence until it settles. A set carrying the file-based restore-pending code ([SCRIPT-FILEBASED-REFERENCES-FALLBACK](SCRIPTING-FILEBASED-SPEC.md)) describes a tier-2 placeholder compilation that a background MSBuild restore is about to replace; nothing else would ever re-publish the corrected set, so the placeholder's phantom `CS0246`s would stay on screen for the life of the document. The provisional state is identified by its own diagnostic code, never by parsing message text.
5. Generations are never reused after `didClose`, preventing an old in-flight fetch from matching a new document generation.
6. A semantic response (completion, hover, navigation, …) for a document whose *latest publication* is provisional is not sent until the host has re-fetched and republished that document's diagnostics. A feature answer computed from the upgraded tier-1 compilation must never reach the editor before the corrected diagnostic set does: the sidecar transport serializes requests, so the convergence fetch runs strictly after the request that produced the answer, and the corrected publication therefore precedes any tier-1-revealing answer on the client stream. Syntax-only, pull-diagnostic, and workspace-scoped requests are exempt — they cannot reveal the upgrade. The sidecar in turn captures a document snapshot and its tier-2 notice atomically (under its solution mutation lock), so a fetched set can never pair a pre-upgrade compilation with a post-upgrade "settled" notice state.

The last publication for a document MUST reflect its newest known text.

### [DIAG-ARCHITECTURE-SCOPE] Analysis Scope

| Mode | Scope | Default | Use Case |
|------|-------|---------|----------|
| **Solution-wide (pull)** | Editor pulls `workspace/diagnostic`; sidecar answers per project on demand | **Enabled** | Full error visibility without opening files |
| **Open files only** | Editor only pulls `textDocument/diagnostic` for documents it has opened | Optional | Editors that don't issue `workspace/diagnostic` |
| **Per-project filter** | `workspace/diagnostic` partial-result handler restricts to filtered projects | Optional | Focus analysis on active development targets |

Solution-wide analysis is the default. The VS Code extension explicitly drives the workspace pull and renders results in the Problems panel before files are opened.

Native input subscriptions follow actual compiler source and project metadata, including adopted projects and linked sources outside the selected solution directory. Directory identity and containment use the host's canonical path module. One subscription covers its descendants; unchanged subscriptions survive scope updates, and obsolete subscriptions are removed when the compiler scope changes.

Compiler notifications refresh this input scope independently of the configured Problems visibility. A workspace pull establishes subscriptions before publishing its successful report. Subscription updates carry the captured input revision so an obsolete query cannot reattach an earlier workspace's roots. Compiler metadata requests run without holding the session lock; watch ownership retains input paths and tasks, while diagnostic result reuse remains exclusively in Salsa.

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

Compiler errors without a user-source location belong to the owning project and appear once at its project URI with a zero-length range at line zero. Source diagnostics keep their actual source owner. Generated-source edit hints such as unused imports do not become project-level Problems entries; compiler errors and warnings remain eligible.

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

#### [DIAG-LSP-CAPABILITIES-EXCLUSIVE] One model per client

The push and pull models are **mutually exclusive per client**. A client offered both runs both: `vscode-languageclient` creates one `DiagnosticCollection` for `publishDiagnostics` and a second one for `textDocument/diagnostic`, and `vscode.languages.getDiagnostics` concatenates every collection, so each diagnostic is reported — and counted — twice.

Clients declaring `textDocument.diagnostic` MUST be offered `diagnosticProvider` and served exclusively through pull, even when they also declare `textDocument.publishDiagnostics`. Modern VS Code declares both capabilities; preferring push in that case prevents its workspace diagnostic client from running. Clients that support only publication use the generation-gated fallback in [DIAG-PUSH-GATE]. No pull client receives a second copy through publication.

### [DIAG-LSP-PULL] Pull Model (`textDocument/diagnostic`, `workspace/diagnostic`)

LSP 3.17 pull diagnostics is the primary model negotiated by modern clients ([DIAG-LSP-CAPABILITIES-EXCLUSIVE]). Both Roslyn and FCS contribute the current diagnostics of their loaded documents. Compiler or sidecar failures MUST produce a retriable request error; they MUST NOT become empty successful reports that falsely claim the source is clean.

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

`resultId` format is `p:{project_version}|d:{doc_version}|g:{global_state_version}`. When `previousResultId` matches the current salsa query identity, the host returns `{ kind: "unchanged" }` (LSP 3.17 §10.6.1) and skips both IPC and semantic analysis.

Workspace request (`workspace/diagnostic`) is supported with partial-result streaming so large solutions don't block on a single response.

### [DIAG-LSP-REFRESH] Refresh Notifications (`workspace/diagnostic/refresh`)

When sidecar state changes update diagnostic salsa inputs, the host sends:

```json
{ "method": "workspace/diagnostic/refresh" }
```

This tells the editor that prior result identities are invalid and it must re-pull. The SharpLsp extension retains no diagnostic result data. Refreshes are debounced 2000ms, collapsing multiple workspace events within the window into one notification.

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
    [Key(1)] string? PreviousResultId;   // reserved for wire compatibility; host sends null
}
```

The sidecar always returns `DiagnosticResult[]` and MUST NOT memoize results or decide `unchanged`. The Rust host's [DIAG-ARCHITECTURE-SALSA] query owns result reuse, assigns `ResultId`, and returns the LSP `Changed`/`Unchanged` report.

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

### [DIAG-IPC-WORKSPACE-PULL] Workspace Diagnostic Metadata

The Rust host calls `workspace/diagnostics/documents` to enumerate user-source identities and `workspace/diagnostics/projects` to enumerate project identities. Both return the same three-field `DiagnosticDocument` records (file path, project name, project path), without compiling or retaining diagnostic results. The source-only contract remains unchanged.

For each salsa miss, `workspace/diagnostics` computes a source document and `workspace/diagnostics/project` computes the requested project-level compiler findings. Both accept the native path and return `DiagnosticResult[]`. The host owns LSP workspace partials and result identities; stable salsa hits skip compiler IPC. A clean project needs no initial editor entry, while a previous project report receives an explicit empty result after repair.

The legacy `workspace/diagnostics/all` bulk RPC MUST NOT be restored; workspace-wide analysis happens lazily through per-document pulls as specified by [DIAG-ARCHITECTURE-EAGER-SCAN].

### [DIAG-IPC-REFRESH] Notification: `diagnostics/refresh`

Sidecar → host notification fired when an input changes and the host must update diagnostic salsa inputs. Payload:

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

Explicit workspace opens honor `diagnostics.auto_restore_on_open`, enabled by default. The host sends that policy before `workspace/open`, including after process recovery. With opt-out, workspace opening leaves missing assets untouched. With opt-in, both compiler engines restore missing or older SDK assets before creating their compiler workspace. Live configuration applies to the next workspace open. Owning-file loads retain the language-specific contracts below.

1. Before calling `MSBuildWorkspace.OpenSolutionAsync`, the sidecar inspects each project's `obj/project.assets.json`.
2. If `assets.json` is missing, older than the `.csproj`, or its `PackageReference` set differs from the `.csproj`, the sidecar shells `dotnet restore <path>` via a `DotnetCliHelper` equivalent. Restore progress is reported via LSP `$/progress` (work-done token established at workspace open).
3. Only after restore completes does the sidecar create `MSBuildWorkspace`.
4. Restore completion bumps `global_state_version` and triggers an initial `diagnostics/refresh`.

The gate is mandatory because unresolved `<PackageReference>` items can produce CS0246/CS0234 diagnostics on the first pull.

**F# owning projects.** Before an owning-file load ([SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-OWNING]), the F# sidecar restores the owner again (`dotnet msbuild -t:Restore`) when its `obj/project.assets.json` names a package that none of the assets file's package folders holds. Clearing the NuGet cache leaves a built project in exactly that state: MSBuild trusts the build's assets cache, so its design-time command line references none of the packages. The netstandard reference pack is one of them, and without its core library FCS aborts every check, so hover, completion and navigation answer nothing. A project that has never been restored is not restored by this owning-file gate. The log names the project, how many packages are gone and the first of them, then whether the restore succeeded.

**C# owning projects.** The C# sidecar never restores a project it loads only because the user opened one of its files ([SHARPLSP-ARCHITECTURE-PROJECTS-CSHARP-OWNING]). An owner with no `obj/project.assets.json` stays unloaded, and the edit reports `dotnet restore <owner>` as the remedy. Opening a file must leave the user's project exactly as it was.

## [DIAG-PERFORMANCE] Performance Targets

| Metric | Target |
|--------|--------|
| Per-document pull (salsa memoized) | <5ms (returns `unchanged`) |
| Per-document pull (cold) | <200ms p50, <500ms p95 |
| Workspace pull, partial result for first document | <500ms after restore completes |
| Workspace pull, full result for 50-project solution | <10s after restore completes |
| Refresh debounce window | 2000ms (matches Roslyn LSP) |
| NuGet restore (`assets.json` valid) | <100ms (gate skipped) |
| NuGet restore (cold) | bounded only by `dotnet restore` itself; surface via `$/progress` |
| Memory overhead (salsa diagnostic memoization) | <200MB additional for 50-project solution |

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

- **Lazy compilation**: on a salsa miss, the sidecar invokes `Project.GetCompilationAsync()` for the requested document's project and returns the resulting diagnostics without retaining a SharpLsp memo table.
- **Salsa query identity**: per [DIAG-LSP-PULL], repeat pulls for unchanged documents return `{ kind: "unchanged" }` from the Rust-host salsa query without re-running Roslyn. The tracked inputs include `global_state_version`, so workspace mutations invalidate affected query values.
- **Workspace event subscription**: the sidecar's `Workspace.RegisterWorkspaceChangedHandler` is the only active background work. It mutates `global_state_version` and emits `diagnostics/refresh`. It does not analyze anything itself.

### [DIAG-ANALYSIS-CANCELLATION] Cancellation

- The Rust host cancels in-flight per-document IPC requests when the editor sends a fresh pull for the same document with a higher `previousResultId`-implied version (or a different `previousResultId`).
- The sidecar passes the IPC `CancellationToken` straight into `GetSemanticModelAsync` / `GetAnalyzerSemanticDiagnosticsAsync`.
- A `WorkspaceChanged` event mid-pull does not cancel the pull. The pull completes against its snapshot, returns its `resultId`, and the bumped `global_state_version` causes the next refresh to invalidate it. This matches `AbstractPullDiagnosticHandler`'s snapshot-isolation behavior in `dotnet/roslyn`.

### [DIAG-ANALYSIS-INCREMENTAL] Incremental Updates

When a file changes:

- The host updates its VFS, sends `textDocument/didChange` IPC to the sidecar (which calls `_solution.WithDocumentText(...)`), and the sidecar emits `diagnostics/refresh` carrying only the affected project's IDs in `AffectedProjectIds`.
- The host's debounced refresh queue collapses bursts; the LSP `workspace/diagnostic/refresh` notification fires once per debounce window.
- The editor re-pulls. Files whose salsa inputs did not change return `{ kind: "unchanged" }` because their `resultId` remains valid.

## [DIAG-TRUTH] Truth Guarantees

### [DIAG-TRUTH-GUARANTEES] Guarantees

- If `dotnet build` succeeds with zero errors against the same source, the next pull (after refresh debounce + restore completion) returns zero Error-severity diagnostics.
- A diagnostic in the Problems panel corresponds to a real Roslyn compiler or analyzer diagnostic from the current `Solution` snapshot.
- A workspace mutation that changes a file's diagnostics produces an LSP `workspace/diagnostic/refresh` within 2000ms (the debounce window). Editors converge to truth one pull cycle after that.

### [DIAG-TRUTH-RECOVERY] Compiler Recovery

A restarted compiler receives the selected workspace and current analyzer policy before it can answer semantic or diagnostic requests. Open documents are replayed from the authoritative host VFS, preserving unsaved text. The host retains bounded workspace/configuration inputs and weak access to the VFS; it retains no second buffer store or diagnostic result cache.

Workspace restoration and document replay run under the same FIFO transport lock as the requesting operation. If restoration fails, the host discards that compiler connection and returns a retriable request error. The first successful pull after recovery must include both closed-file compiler errors and current unsaved-buffer errors from the selected workspace.

### [DIAG-TRUTH-LIMITS] Limits

- The first pull during workspace load may be incomplete. The response reflects the current snapshot; after [DIAG-RESTORE], project-reference and NuGet types are resolved, but source-generator output may still be missing.
- The remedy for "incomplete but not wrong" is `workspace/diagnostic/refresh`. Generator output materializing fires a `WorkspaceChanged` event → refresh → re-pull → complete result.
