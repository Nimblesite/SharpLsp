---
layout: layouts/docs.njk
title: Configuration
eleventyNavigation:
  key: Configuration
  order: 9
---

# Configuration

Forge is configured via a `forge.toml` file placed at the root of your workspace (alongside your `.sln` or root `.csproj`). All settings have sensible defaults — the file is optional.

`forge.toml` uses `deny_unknown_fields` — any key not listed below will cause a parse error at startup.

## forge.toml Reference

```toml
# forge.toml — full configuration reference
# Every key shown is optional; defaults are applied when omitted.

# ─── Server ────────────────────────────────────────────────────────────────────
[server]
# Log level: "trace", "debug", "info", "warn", "error"
log_level = "info"

# Debounce window in milliseconds for semantic requests after a keystroke
debounce_ms = 150

# ─── C# ────────────────────────────────────────────────────────────────────────
[csharp]
# Enable the C# sidecar
enabled = true

# Path to the .sln file to load. Empty = auto-detect.
solution_path = ""

# ─── F# ────────────────────────────────────────────────────────────────────────
[fsharp]
# Enable the F# sidecar
enabled = true

# ─── Diagnostics ───────────────────────────────────────────────────────────────
[diagnostics]
# Run Roslyn analyzers (not just compiler errors)
analyzers_enabled = true

# Analyze all files in the solution, not just open ones
solution_wide_analysis = true

# Project name patterns to include (empty = all projects)
project_filter = []

# ─── Profiler ──────────────────────────────────────────────────────────────────
[profiler]
# Maximum concurrent profiling sessions
max_concurrent_sessions = 5

# Default trace duration in seconds (0 = unlimited)
default_trace_duration = 30

# Default trace output format ("speedscope", "chromium", "nettrace")
default_trace_format = "speedscope"

# Default counter providers
default_counter_providers = ["System.Runtime"]

# Default counter refresh interval in seconds
default_counter_interval = 1

# Output directory for trace/dump files
output_directory = ".forge/profiles"
```

## File Location

Forge searches for `forge.toml` by walking up the directory tree from the workspace root. The first `forge.toml` found is used. If none is found, all defaults apply.

```
my-solution/
├── forge.toml          ← place it here
├── MyApp.sln
├── MyApp.Core/
│   └── MyApp.Core.csproj
└── MyApp.Api/
    └── MyApp.Api.csproj
```

## Per-Project Overrides

`.editorconfig` rules are respected for C# formatting. Roslyn maps `.editorconfig` severity settings directly to analyzer severity:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.IDE0003.severity = warning   # Remove 'this' qualification
dotnet_diagnostic.CA1054.severity = error       # URI parameters should not be strings
```

## Disabling a Language

To skip starting a sidecar entirely, set its `enabled` flag to `false`:

```toml
[fsharp]
enabled = false
```

Requests for that language will be rejected and no sidecar process will be spawned.
