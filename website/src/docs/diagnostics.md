---
layout: layouts/docs.njk
title: Diagnostics
eleventyNavigation:
  key: Diagnostics
  order: 5
---

# Diagnostics

Forge delivers real-time C# compiler errors, warnings, and Roslyn analyzer diagnostics for your entire solution — not just open files. Solution-wide analysis is **on by default**, which is the #1 feature C# Dev Kit lacks and the primary reason developers choose Visual Studio or Rider for large solutions.

## How It Works

```
Editor ←→ Rust LSP Host ←→ C# Sidecar
  ↑            ↑                ↑
Problems   publishDiagnostics  Roslyn
window     notifications       GetDiagnostics()
```

1. **Document change** — editor sends `textDocument/didChange`, Rust host updates VFS and tree-sitter
2. **Debounce** — changes are coalesced over a 150ms window (configurable)
3. **Dispatch** — Rust host sends a `workspace/diagnostics` request to the appropriate sidecar
4. **Analysis** — Roslyn or FCS runs full semantic analysis on the affected scope
5. **Publish** — results are mapped to LSP `Diagnostic` objects and pushed to the editor

## Analysis Scope

| Mode | Default | Description |
|------|---------|-------------|
| **Solution-wide** | ✓ | All documents in all loaded projects |
| Open files only | ✗ | Only documents currently open in the editor |
| Per-project filter | ✗ | Specific projects matched by name pattern |

Solution-wide analysis catches errors in files you haven't opened — build breaks in other projects, missing method implementations, type mismatches across project boundaries.

## Diagnostic Categories

### Compiler Diagnostics

| Language | Examples |
|----------|----------|
| C# (Roslyn) | `CS0029` (type conversion), `CS0246` (type not found), `CS8600`–`CS8798` (nullable) |

### Analyzer Diagnostics

- **Built-in Roslyn analyzers** — IDE0001–IDE0090, CA1000–CA2000 code quality rules
- **.editorconfig rules** — code style enforcement mapped from `.editorconfig` severity
- **Third-party NuGet analyzers** — StyleCop, SonarAnalyzer, and any `<Analyzer>` reference

### Live Squiggles

Diagnostics are pushed in three situations:

- **On document change** — re-analysis after the debounce window
- **On project change** — re-analysis when `.csproj` / `.fsproj` changes
- **On solution load** — full solution scan, streamed incrementally

## Configuration

```toml
# forge.toml
[diagnostics]
# Run Roslyn/FCS analyzers (not just compiler errors)
analyzers_enabled = true

# Analyze all files in the solution, not just open ones
solution_wide_analysis = true

# Restrict analysis to specific projects (glob patterns, empty = all)
project_filter = []

# Minimum severity to report: "error", "warning", "info", "hint"
min_severity = "hint"

# Maximum diagnostics per file (0 = unlimited)
max_per_file = 0
```

### Project Filter

Narrow the scope for large monorepos:

```toml
[diagnostics]
project_filter = ["MyApp.Core", "MyApp.Api", "MyApp.Tests.*"]
```

Changes to `solution_wide_analysis` and `project_filter` take effect immediately via `workspace/didChangeConfiguration` — no restart needed.

## Performance Targets

| Metric | Target |
|--------|--------|
| Single file refresh | <500ms from keystroke |
| Solution-wide initial scan | <10s for 50-project solution |
| Incremental re-analysis | <1s after single file edit |
| Memory overhead (solution-wide) | <200MB for 50 projects |

## Severity Mapping

| Roslyn / FCS Severity | LSP Severity |
|-----------------------|-------------|
| Error | 1 — Error |
| Warning | 2 — Warning |
| Info | 3 — Information |
| Hidden | 4 — Hint |

## Competitive Comparison

| Feature | Visual Studio | C# Dev Kit | Rider | **Forge** |
|---------|:---:|:---:|:---:|:---:|
| Compiler errors and warnings | ✓ | ✓ | ✓ | ✓ |
| Roslyn analyzer diagnostics | ✓ | ✓ | ✓ | ✓ |
| Solution-wide analysis (default on) | ✓ | ✗ | ✓ | **✓** |
| Unused using detection | ✓ | ✓ | ✓ | ✓ |
| Nullable reference analysis | ✓ | ✓ | ✓ | ✓ |
| Third-party NuGet analyzers | ✓ | ✓ | ✓ | ✓ |

Solution-wide analysis is default-on in Forge. C# Dev Kit doesn't support it at all. This single difference makes Forge the correct choice for any multi-project solution.

## Screenshot

![Diagnostics documentation page]({{ "/assets/screenshots/diagnostics-page.png" | url }})

*Real-time Roslyn diagnostics across your entire solution — not just open files.*
