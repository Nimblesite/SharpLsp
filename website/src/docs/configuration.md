---
layout: layouts/docs.njk
title: Configuration
eleventyNavigation:
  key: Configuration
  order: 9
---

# Configuration

Forge is configured via a `forge.toml` file placed at the root of your workspace (alongside your `.sln` or root `.csproj`). All settings have sensible defaults — the file is optional.

## forge.toml Reference

```toml
# forge.toml — full configuration reference

# ─── Diagnostics ───────────────────────────────────────────────────────────────
[diagnostics]
# Run Roslyn/FCS analyzers (not just compiler errors)
analyzers_enabled = true

# Analyze all files in the solution, not just open ones
solution_wide_analysis = true

# Restrict analysis to specific projects (glob patterns)
# Empty = analyze all projects
project_filter = []

# Minimum severity to report: "error", "warning", "info", "hint"
min_severity = "hint"

# Maximum diagnostics per file (0 = unlimited)
max_per_file = 0

# Debounce window in milliseconds before triggering re-analysis
debounce_ms = 150

# ─── Completions ───────────────────────────────────────────────────────────────
[completions]
# Show types from unimported assemblies (adds using/open automatically)
import_completions = true

# Maximum results per request
max_results = 200

# ─── Formatting ────────────────────────────────────────────────────────────────
[format]
# Format on save (requires editor support)
on_save = false

[format.csharp]
# Use .editorconfig for C# formatting options (default: true)
use_editorconfig = true

[format.fsharp]
# Fantomas version (default: latest bundled)
fantomas_version = "latest"

# ─── F# ────────────────────────────────────────────────────────────────────────
[fsharp]
# Enable Fantomas formatting
formatting = true

# Enable FSharpLint diagnostics
lint = true

# Enable FSharp.Analyzers.SDK
analyzers = true

# ─── Sidecar ───────────────────────────────────────────────────────────────────
[sidecar]
# Maximum restart attempts before giving up (0 = unlimited)
max_restarts = 10

# Delay between restart attempts in milliseconds (doubles each attempt)
restart_delay_ms = 500

# ─── Logging ───────────────────────────────────────────────────────────────────
[log]
# Log level: "trace", "debug", "info", "warn", "error"
level = "info"

# Log file path (empty = stderr only)
file = ""
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

## Hot Reload

Most settings are hot-reloadable via `workspace/didChangeConfiguration`. Changes to `solution_wide_analysis`, `project_filter`, `min_severity`, and `analyzers_enabled` take effect without restarting Forge.

Settings that require a restart:
- `[sidecar]` settings
- `[log]` settings

## Per-Project Overrides

For fine-grained control, `.editorconfig` rules are respected for C# formatting. Roslyn maps `.editorconfig` severity settings directly to analyzer severity:

```ini
# .editorconfig
[*.cs]
dotnet_diagnostic.IDE0003.severity = warning   # Remove 'this' qualification
dotnet_diagnostic.CA1054.severity = error       # URI parameters should not be strings
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `FORGE_LOG` | Override log level (e.g., `FORGE_LOG=debug`) |
| `FORGE_CONFIG` | Override path to `forge.toml` |
| `FORGE_DOTNET_ROOT` | Override .NET SDK root for MSBuild discovery |

## Disabling Features

To run Forge in a minimal mode (syntax only, no sidecar):

```toml
[diagnostics]
analyzers_enabled = false
solution_wide_analysis = false

[completions]
import_completions = false
```

This disables sidecar startup and all semantic operations. Forge will still provide tree-sitter-powered document symbols, folding ranges, and selection ranges at full speed.
