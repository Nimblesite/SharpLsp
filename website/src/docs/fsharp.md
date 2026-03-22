---
layout: layouts/docs.njk
title: F# Support
eleventyNavigation:
  key: F# Support
  order: 8
---

# F# Support

F# is a **first-class citizen** in Forge, not a bolt-on or afterthought. Every feature available for C# is implemented with equal depth for F#. There are no "F# not supported" fallbacks.

## Why F# Deserves Better Tooling

The F# developer experience in most editors is managed by Ionide — a community project. Rider and Visual Studio have proprietary F# support. Forge is the first open-source LSP implementation that treats F# with the same engineering investment as C#, implemented via the same FSharp.Compiler.Service APIs that Ionide uses.

## F# Sidecar Architecture

The F# sidecar is a long-running .NET process that loads alongside the C# sidecar. It communicates with the Rust host over the same IPC protocol (MessagePack over Unix sockets / named pipes).

```
Rust LSP Host
     │
     ├─── C# Sidecar (Roslyn)     ← .cs files
     └─── F# Sidecar (FCS)        ← .fs / .fsi / .fsx files
```

### Components

| Component | Role |
|-----------|------|
| `FSharpChecker` | Type checking, symbol resolution, completions |
| `Ionide.ProjInfo` | Project system — loads `.fsproj`, resolves references |
| `Fantomas` | Code formatting |
| `FSharpLint.Core` | Linting and code style diagnostics |
| `FSharp.Analyzers.SDK` | Plugin-based community analyzers |

## Feature Coverage

### Completions

- Module members, bindings, and type names
- Record field names in `{` and `with` positions
- Discriminated union cases in `match` expressions
- Computation expression keywords (`let!`, `do!`, `return!`, `yield!`)
- Attribute names in `[<Attribute>]` positions
- Automatic `open` insertion for unimported modules

### Diagnostics

- Full FSharpChecker compiler errors and warnings (all `FS` codes)
- FSharpLint code style diagnostics
- FSharp.Analyzers.SDK — community analyzers (Forge is the only non-Ionide tool supporting these)

### Hover

- Type signatures with full generic constraints
- XML documentation from `///` and NuGet `.xml` files
- Discriminated union case fields
- Computation expression builder method signatures
- Unit of measure annotations

### Go to Definition

- Module functions and `let` bindings
- Discriminated union cases
- Record fields
- Active patterns
- CE builder methods
- Pattern bindings

### Formatting (Fantomas)

Forge uses [Fantomas](https://fsprojects.github.io/fantomas/) for F# formatting — the community standard formatter that all major F# tooling agrees on.

```toml
# forge.toml
[format.fsharp]
# Fantomas configuration passed through
fantomasVersion = "latest"
```

Formatting is triggered via `textDocument/formatting` and `textDocument/rangeFormatting`.

### Code Folding

Tree-sitter handles F# folding ranges at sub-millisecond speeds in the Rust host, with no sidecar round-trip needed.

![F# editing in VS Code with Forge]({{ "/assets/screenshots/fsharp-editing.png" | url }})

*F# code editing with completions and syntax highlighting in VS Code.*

## Project Loading

Project loading uses `Ionide.ProjInfo` to resolve `.fsproj` and solution files. Forge monitors the filesystem for changes to project files and reloads automatically.

### Supported Project Types

- `.fsproj` — standard F# project files
- `.fsx` — F# scripts (with nuget references via `#r "nuget: PackageName"`)
- `.fsi` — F# signature files
- Solution-level loading via `.sln`

## Configuration

```toml
# forge.toml
[fsharp]
# Path to the .fsproj or .sln file (auto-detected if not set)
project_path = ""

# Enable Fantomas formatting
formatting = true

# Enable FSharpLint diagnostics
lint = true

# Enable FSharp.Analyzers.SDK
analyzers = true
```

## Competitive Comparison

| Feature | Ionide | Rider | **Forge** |
|---------|:---:|:---:|:---:|
| Completions | ✓ | ✓ | ✓ |
| Diagnostics | ✓ | ✓ | ✓ |
| Hover | ✓ | ✓ | ✓ |
| Go to definition | ✓ | ✓ | ✓ |
| Fantomas formatting | ✓ | ✓ | ✓ |
| FSharpLint | ✓ | ✗ | ✓ |
| FSharp.Analyzers.SDK | ✓ | ✗ | **✓** |
| Cross-language (F# ↔ C#) | ✗ | partial | **✓** |
| Zero proprietary code | ✓ | ✗ | **✓** |
| Works in any LSP editor | ✓ | ✗ | **✓** |
