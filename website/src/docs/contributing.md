---
layout: layouts/docs.njk
title: Contributing
eleventyNavigation:
  key: Contributing
  order: 13
---

# Contributing & Building from Source

This page is for contributors who want to build SharpLsp from source. If you just want to use SharpLsp, install the VS Code extension — it ships with everything bundled.

## Prerequisites

- **Rust** (stable, latest) — install via [rustup](https://rustup.rs)
- **.NET 10.0 SDK** — [download](https://dotnet.microsoft.com/download)
- **Node 20** — for the VS Code extension

## Recommended: Dev Container

The fastest path is the included dev container. It comes pre-configured with Rust, .NET 10 SDK, Node 20, and all required tooling.

1. Install [Docker](https://www.docker.com/) and the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers)
2. Open the repository in VS Code
3. Click **Reopen in Container** when prompted

## Manual Setup

```sh
# Build the Rust LSP host
cargo build

# Run clippy lints
cargo clippy

# Run tests
cargo test

# Build the VS Code extension VSIX
cd editors/vscode && npm install && npm run compile
```

## Repository Structure

```
sharplsp/
├── src/                  # Rust LSP host
├── sidecars/
│   ├── SharpLsp.Sidecar.FSharp/   # F# sidecar (FSharp.Compiler.Service)
│   ├── SharpLsp.Sidecar.CSharp/   # C# sidecar (Roslyn)
│   └── SharpLsp.Sidecar.Common/   # Shared sidecar code
├── editors/
│   ├── vscode/           # VS Code extension (TypeScript)
│   └── zed/              # Zed extension (Rust → wasm32-wasip1)
├── docs/                 # Specs and implementation plans
├── tests/                # E2E tests
└── website/              # This site
```

## Architecture

Three-tier architecture:

- **Tier 1 — Rust LSP Host**: LSP connection (JSON-RPC over stdio), VFS, tree-sitter incremental parsing, request routing, sidecar lifecycle
- **Tier 2 — C# Sidecar (Roslyn)**: MSBuildWorkspace, full Roslyn API (completions, diagnostics, refactorings, formatting)
- **Tier 3 — F# Sidecar (FCS)**: FSharp.Compiler.Service, Fantomas, FSharpLint

IPC uses MessagePack over named pipes (Windows) / Unix domain sockets (Linux, macOS).

See [Architecture](/docs/architecture/) for the full breakdown.

<p class="next-link"><a href="/docs/architecture/">Next: Architecture <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span></a></p>
