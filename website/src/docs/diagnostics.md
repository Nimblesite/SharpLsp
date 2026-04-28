---
layout: layouts/docs.njk
title: Diagnostics
eleventyExcludeFromCollections: true
---

![Diagnostics in VS Code](/assets/screenshots/vscode-diagnostics-page.png)

*Roslyn diagnostics in the alpha VS Code extension.*

# Diagnostics

SharpLsp routes C# compiler errors, warnings, and Roslyn analyzer diagnostics through the C# sidecar. The current website shows the VS Code extension state; F# diagnostics are still in progress.

## How It Works

```
Editor ←→ Rust LSP Host ←→ C# Sidecar
  ↑            ↑                ↑
Problems   publishDiagnostics  Roslyn
window     notifications       GetDiagnostics()
```

1. **Document change** — editor sends `textDocument/didChange`, Rust host updates VFS and tree-sitter
2. **Debounce** — changes are coalesced over a 150ms window (configurable)
3. **Dispatch** — Rust host sends a `workspace/diagnostics` request to the C# sidecar
4. **Analysis** — Roslyn runs full semantic analysis on the affected scope
5. **Publish** — results are mapped to LSP `Diagnostic` objects and pushed to the editor

> **Note:** Diagnostics are currently C# only. F# diagnostics via FCS are not yet implemented.

## Analysis Scope

| Mode | Default | Description |
|------|---------|-------------|
| **Solution-wide** | ✓ | All documents in all loaded projects |
| Open files only | ✗ | Only documents currently open in the editor |
| Per-project filter | ✗ | Specific projects matched by name pattern |

Solution-wide analysis is part of the SharpLsp direction. The alpha extension is still being hardened, so treat diagnostics behavior as active development rather than a beta stability guarantee.

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
# sharplsp.toml
[diagnostics]
# Run Roslyn analyzers (not just compiler errors)
analyzers_enabled = true

# Analyze all files in the solution, not just open ones
solution_wide_analysis = true

# Restrict analysis to specific projects by name (empty = all)
project_filter = []
```

### Project Filter

Narrow the scope for large monorepos:

```toml
[diagnostics]
project_filter = ["MyApp.Core", "MyApp.Api"]
```

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
