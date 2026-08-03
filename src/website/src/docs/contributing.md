---
layout: layouts/docs.njk
title: Contributing
eleventyNavigation:
  key: Contributing
  order: 13
---

# Contributing and Building from Source

This page is for contributors. VS Code users should normally install the Marketplace extension, which bundles the host and sidecars.

## Prerequisites

- Rust stable, installed with [rustup](https://rustup.rs)
- .NET 10 SDK (the repository pins 10.0.203 with compatible roll-forward)
- Node.js 20 or newer
- Git

Some profiler tests also require the `dotnet-trace`, `dotnet-counters`, and `dotnet-dump` global tools.

## Dev Container

The included dev container supplies the Rust, .NET, Node, and test tooling used by the project. Open the repository in VS Code and choose **Dev Containers: Reopen in Container**.

## Repository Layout

```text
SharpLsp/
├── Cargo.toml                    # Root Rust workspace manifest
├── src/
│   ├── sharplsp/                 # Rust host, build script, and Rust E2E tests
│   ├── sidecars/                 # C#, F#, and shared .NET sidecars/tests
│   ├── editors/
│   │   ├── vscode/               # VS Code extension
│   │   ├── zed/                  # Zed integration source
│   │   └── rider/                # Rider integration source
│   ├── examples/                 # Example solutions and configuration
│   ├── fixtures/                 # Test and real-world fixtures
│   └── website/                  # Eleventy documentation site
├── docs/                         # Technical specifications and plans
└── tools/                        # Build, packaging, coverage, and shared make helpers
```

## Build and Test

Run commands from the repository root.

```sh
# Rust host
cargo build
cargo clippy --all-targets --all-features
cargo test

# .NET sidecars
dotnet test src/sidecars/SharpLsp.Sidecars.sln

# VS Code extension
npm --prefix src/editors/vscode ci
npm --prefix src/editors/vscode run lint
npm --prefix src/editors/vscode run package

# Website
npm --prefix src/website ci
npm --prefix src/website run build
npm --prefix src/website test
```

The extension's end-to-end suite stages real SharpLsp binaries and launches a VS Code test host. It is heavier than the TypeScript checks; use the repository's Make targets and CI workflow as the source of truth for the complete matrix.

## Architecture

SharpLsp has three runtime tiers:

- the Rust LSP host;
- the Roslyn C# sidecar;
- the FCS F# sidecar.

IPC uses MessagePack over named pipes on Windows and Unix domain sockets on Linux/macOS. Read [Architecture](/docs/architecture/) before changing cross-tier behavior.

## Documentation Sources

Public website documentation lives under `src/website/src/docs` with Japanese and Simplified Chinese counterparts under `src/website/src/ja/docs` and `src/website/src/zh/docs`.

Technical behavior specifications live in `docs/specs`; implementation plans live in `docs/plans`. Update public docs and both translations whenever user-visible behavior changes.

<p class="next-link"><a href="/docs/architecture/">Architecture <span aria-hidden="true">→</span></a></p>
