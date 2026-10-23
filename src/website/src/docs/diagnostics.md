---
layout: layouts/docs.njk
title: Diagnostics
description: "C# and F# diagnostics in SharpLsp: Roslyn and F# Compiler Service errors on unsaved code, push and pull delivery, and SharpLsp's unused-open and dead-code analyzers."
---

<img src="/assets/screenshots/docs/diagnostics.webp" alt="The Problems panel with an F# type error from the F# Compiler Service and a C# CS0029 error from Roslyn, both from unsaved edits" width="2400" height="1500">

# Diagnostics

SharpLsp reports compiler diagnostics for both C# and F#. Roslyn handles C# files; the F# Compiler Service handles F# files. Each sidecar analyzes the current editor buffer, so unsaved changes are included.

{% video "diagnostics" %}

## Delivery Model

Modern clients, including VS Code, use LSP 3.17 pull diagnostics:

- **Document pull:** `textDocument/diagnostic` fetches the current file's diagnostics.
- **Workspace pull:** `workspace/diagnostic` includes loaded F# and C# source files, including unopened files. Solution-wide analysis is enabled by default; the VS Code extension requests these results for the Problems panel.
- **Push fallback:** clients without pull support receive `textDocument/publishDiagnostics`. Each client uses one delivery model, so errors appear once.

Unsaved edits, closed-file disk changes and project inputs refresh the affected diagnostics. Closing a file keeps its real errors visible while solution-wide analysis is enabled. Disabling solution-wide analysis clears closed-file results while open-file diagnostics remain available.

A generation gate prevents older push requests from overwriting newer results in clients using the fallback.

## Diagnostic Sources

| Language | Sources available today |
|---|---|
| F# | FCS compiler diagnostics plus `SLSPF0101` dead code, `SLSPF0102` unused `open`, and `SLSPF0103` redundant qualifier |
| C# | Roslyn compiler diagnostics, the project's SDK/NuGet Roslyn analyzers, and SharpLsp dead-code diagnostics (`SLSPC0101`) |

Roslyn analyzers follow the project's evaluated analyzer references, `.editorconfig`, `NoWarn` and source suppressions. An `.editorconfig` rule does not load an analyzer assembly the project does not reference. `diagnostics.analyzers_enabled` controls analyzer diagnostics; compiler errors remain visible. FSharpLint and FSharp.Analyzers.SDK integrations are not currently available.

## Configuration

```toml
[diagnostics]
# Include unopened F# and C# sources in solution diagnostics
solution_wide_analysis = true

# Project names or paths relative to the selected solution; empty means all
project_filter = []

# Run analyzer diagnostics without hiding compiler errors
analyzers_enabled = true

# Minimum severity: error, warning, info or hint
min_severity = "hint"

# Cap each file after severity filtering; 0 means unlimited
max_per_file = 0

[analyzers]
# SharpLsp dead-code analyzers for C# and F#
dead_code = true

# Treat the repository as the complete usage boundary
monorepo = false
```

Project filters apply to workspace results for both languages. Direct `textDocument/diagnostic` requests remain unfiltered. Filters also accept full native project paths, using forward slashes in glob patterns.

In normal mode, private/internal dead code is reported as a warning and public symbols are treated as possible external API. In monorepo mode, unused public symbols are also reported and use error severity.

## Severity Mapping

| Compiler / analyzer severity | LSP severity |
|---|---|
| Error | 1 — Error |
| Warning | 2 — Warning |
| Info | 3 — Information |
| Hidden / hint | 4 — Hint |

The `server.debounce_ms` field is accepted for configuration compatibility but is not currently applied; diagnostic requests start immediately and stale results are suppressed by the generation gate.
