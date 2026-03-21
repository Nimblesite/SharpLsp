# DIAGNOSTICS-SPEC

Diagnostics are the core feedback loop for developers. Forge must surface all compiler errors, warnings, and analyzer diagnostics across the entire solution in real-time, matching Visual Studio's Solution-Wide Error Analysis (SWEA) from day one.

## 1. Architecture

```
Editor ←→ Rust LSP Host ←→ C#/F# Sidecar (Roslyn / FCS)
  ↑           ↑                    ↑
  Problems    publishDiagnostics   Compilation.GetDiagnostics()
  window      notifications        DiagnosticAnalyzer framework
```

### 1.1 Request Flow

1. **Document change**: Editor sends `textDocument/didChange` → Rust host updates VFS + tree-sitter
2. **Debounce**: Rust host coalesces changes (150ms window, configurable via `debounce_ms`)
3. **Dispatch**: Rust host sends `workspace/diagnostics` request to sidecar via IPC
4. **Sidecar analysis**: Roslyn runs `GetDiagnostics()` on the semantic model
5. **Response**: Sidecar returns `DiagnosticResult[]` (MessagePack) over IPC
6. **Publish**: Rust host maps `DiagnosticResult` → LSP `Diagnostic` and sends `textDocument/publishDiagnostics` notification to the editor

### 1.2 Analysis Scope

| Mode | Scope | Default | Use Case |
|------|-------|---------|----------|
| **Solution-wide** | All documents in all loaded projects | **Enabled** | Full error visibility without opening files |
| **Open files only** | Only documents with `textDocument/didOpen` | Disabled | Large solutions where full analysis is too expensive |
| **Per-project filter** | Specific projects by name/path pattern | Disabled | Focus analysis on active development targets |

Solution-wide analysis is the default because developers need to see errors **everywhere**, not just in open files. This is Visual Studio's SWEA behavior and the #1 reason C# Dev Kit loses to VS — it doesn't do this.

## 2. Configuration

```toml
# forge.toml
[diagnostics]
# Run Roslyn/FCS analyzers (not just compiler diagnostics)
analyzers_enabled = true

# Analyze all files in the solution, not just open ones (default: true)
solution_wide_analysis = true

# Filter which projects to analyze (glob patterns, empty = all)
# Reduces analysis scope for massive solutions
project_filter = []

# Severity threshold — only report diagnostics at this level or above
# Values: "error", "warning", "info", "hint"
min_severity = "hint"

# Maximum diagnostics per file (0 = unlimited)
max_per_file = 0
```

### 2.1 Project Filter

The `project_filter` field accepts glob patterns matched against project names or relative paths:

```toml
[diagnostics]
# Only analyze these projects
project_filter = ["MyApp.Core", "MyApp.Api", "MyApp.Tests.*"]
```

When empty (default), all projects in the solution are analyzed.

### 2.2 Runtime Reconfiguration

Diagnostics settings are hot-reloadable via `workspace/didChangeConfiguration`. Changing `solution_wide_analysis` or `project_filter` triggers a re-analysis of the new scope.

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

Push diagnostics via `textDocument/publishDiagnostics` for immediate editor feedback:

- **On document change**: Re-analyze after debounce window
- **On project change**: Re-analyze affected documents when `.csproj`/`.fsproj` changes
- **On solution load**: Full solution analysis, diagnostics streamed incrementally

## 4. LSP Protocol

### 4.1 Server Capabilities

```json
{
  "diagnosticProvider": {
    "interFileDependencies": true,
    "workspaceDiagnostics": true
  }
}
```

### 4.2 Push Model (`textDocument/publishDiagnostics`)

Primary model. The server proactively sends diagnostics as they are computed:

```json
{
  "method": "textDocument/publishDiagnostics",
  "params": {
    "uri": "file:///path/to/File.cs",
    "version": 42,
    "diagnostics": [
      {
        "range": { "start": { "line": 10, "character": 4 }, "end": { "line": 10, "character": 20 } },
        "severity": 1,
        "code": "CS0029",
        "source": "csharp",
        "message": "Cannot implicitly convert type 'string' to 'int'"
      }
    ]
  }
}
```

### 4.3 Pull Model (`textDocument/diagnostic`, `workspace/diagnostic`)

Secondary model for clients that support LSP 3.17 pull diagnostics:

- `textDocument/diagnostic` — diagnostics for a single document
- `workspace/diagnostic` — diagnostics across the workspace (solution-wide)

### 4.4 Severity Mapping

| Roslyn Severity | LSP DiagnosticSeverity |
|-----------------|----------------------|
| `Error` | 1 (Error) |
| `Warning` | 2 (Warning) |
| `Info` | 3 (Information) |
| `Hidden` | 4 (Hint) |

## 5. Sidecar IPC Messages

### 5.1 Request: `workspace/diagnostics`

Payload: MessagePack-serialized `string` (file path) or `null` (solution-wide).

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

### 5.3 Solution-Wide Request: `workspace/diagnostics/all`

New IPC method for full solution analysis. Returns diagnostics grouped by file:

Payload: MessagePack-serialized `string[]` (project name filters, empty = all).

Response: `Dictionary<string, DiagnosticResult[]>` — keyed by file path.

## 6. Performance Targets

| Metric | Target |
|--------|--------|
| Single file diagnostic refresh | <500ms from keystroke |
| Solution-wide initial scan | <10s for 50-project solution |
| Incremental re-analysis | <1s after single file edit |
| Memory overhead (solution-wide) | <200MB additional for 50-project solution |

## 7. Competitive Analysis

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

Key differentiator: **SWEA is default-on in Forge.** C# Dev Kit doesn't do it at all. This alone justifies Forge's existence for any developer who works with multi-project solutions.

## 8. Background Analysis Strategy

### 7.1 Prioritization

1. **Active document** — highest priority, analyzed immediately after debounce
2. **Visible documents** — analyzed next (open tabs)
3. **Recently edited documents** — queued by recency
4. **Remaining solution documents** — background scan, lowest priority

### 7.2 Cancellation

- New edits cancel in-flight analysis for the same document
- Project-level re-analysis cancels stale per-file analysis
- Solution reload cancels all pending analysis

### 7.3 Incremental Updates

When a file changes, only re-analyze:
- The changed file
- Files with direct dependencies on the changed file's types/members
- Roslyn handles this via `Compilation` incremental updates
