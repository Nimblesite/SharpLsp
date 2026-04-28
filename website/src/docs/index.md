---
layout: layouts/docs.njk
title: Getting Started
eleventyNavigation:
  key: Getting Started
  order: 1
---

# Getting Started

Forge is an open-source .NET Language Server Protocol (LSP) implementation built in Rust. One server provides C# and F# language support across editors that speak LSP.

## Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [.NET 10.0 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)
- Node 20 for building the VS Code extension
- An LSP-compatible editor, or the Forge VS Code, Zed, or Rider extension

## Installation

### Build From Source

```bash
git clone https://github.com/MelbourneDeveloper/forge.git
cd forge
make install
```

`make install` installs `forge-lsp` to `~/.local/bin` and stages the sidecars under `~/.local/lib/forge`.

### VS Code Extension

Build and install the local VSIX:

```bash
make build-vsix
code --install-extension forge.vsix
```

### Zed Extension

Zed builds extensions from source, so package the staged extension tree first:

```bash
rustup target add wasm32-wasip1
make package-zed
```

In Zed, run `zed: install dev extension` and choose `target/zed-extension/`.

### Rider Plugin

```bash
make package-rider
```

In Rider, install `forge-rider.zip` from **Settings -> Plugins -> Install Plugin from Disk**.

## Architecture Overview

Forge uses a three-tier architecture:

| Tier | Component | Role |
|------|-----------|------|
| **1** | Rust LSP Host | LSP connection, VFS, tree-sitter parsing, request routing |
| **2** | C# Sidecar | Roslyn-powered completions, diagnostics, refactoring |
| **3** | F# Sidecar | FSharp.Compiler.Service, FSharpLint diagnostics |

The Rust host handles all LSP communication and syntax-level operations. Semantic operations are delegated to the appropriate .NET sidecar process over IPC.

## Next Steps

- [Architecture](/docs/architecture/) — deep dive into the three-tier design
- [Editor Setup](/docs/editors/) — configure your editor or extension to use Forge
