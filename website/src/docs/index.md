---
layout: layouts/docs.njk
title: Getting Started
eleventyNavigation:
  key: Getting Started
  order: 1
---

# Getting Started

![Forge active in VS Code](/assets/screenshots/vscode-getting-started-page.png)

Forge is an open-source .NET Language Server Protocol (LSP) implementation built in Rust. One server provides C# and F# language support across editors that speak LSP.

## Prerequisites

- [Rust](https://rustup.rs/) (latest stable)
- [.NET 10.0 SDK](https://dotnet.microsoft.com/download/dotnet/10.0)
- An LSP-compatible editor (VS Code, Neovim, Emacs, Helix, Zed, etc.)

## Installation

### From Source

```bash
git clone https://github.com/MelbourneDeveloper/forge.git
cd forge
cargo build --release
```

### VS Code Extension

Install the Forge extension from the VS Code marketplace, or install the `.vsix` file directly.

## Architecture Overview

Forge uses a three-tier architecture:

| Tier | Component | Role |
|------|-----------|------|
| **1** | Rust LSP Host | LSP connection, VFS, tree-sitter parsing, salsa cache |
| **2** | C# Sidecar | Roslyn-powered completions, diagnostics, refactoring |
| **3** | F# Sidecar | FSharp.Compiler.Service, FSharpLint diagnostics |

The Rust host handles all LSP communication and syntax-level operations. Semantic operations are delegated to the appropriate .NET sidecar process over IPC.

## Next Steps

- [Architecture](/docs/architecture/) — deep dive into the three-tier design
- [Editor Setup](/docs/editors/) — configure your editor to use Forge
