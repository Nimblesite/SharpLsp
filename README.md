# Forge

The open-source, editor-agnostic .NET LSP (C# + F#) built in Rust. One LSP server = complete .NET development experience across every editor.

**Overall aim: Fix the .NET developer experience.**
Full feature-for-feature superiority over Visual Studio, Rider, and C# Dev Kit. Zero proprietary dependencies. Zero licenses. Zero vendor lock-in.

## Getting Started

### Recommended: Dev Container

The fastest way to get a working development environment is the included dev container. It comes pre-configured with Rust, .NET 9 SDK, Node 20, and all required tooling.

1. Install [Docker](https://www.docker.com/) and the [Dev Containers extension](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers) for VS Code
2. Open this repository in VS Code
3. When prompted, click **Reopen in Container** (or run `Dev Containers: Reopen in Container` from the command palette)
4. The container will build with Rust, .NET 9 SDK, Node 20, clippy, rustfmt, and the VS Code extension dependencies

### Manual Setup

If you prefer to develop locally:

- **Rust** (stable, latest) with `clippy` and `rustfmt` components
- **.NET 9 SDK** for sidecar development
- **Node 20** for the VS Code extension

```sh
# Build the Rust LSP host
cargo build

# Run clippy lints
cargo clippy

# Run tests
cargo test

# Build the VS Code extension
cd editors/vscode && npm install && npm run compile
```

## Architecture

Three-tier architecture:

- **Tier 1 — Rust LSP Host**: LSP connection (JSON-RPC over stdio), VFS, tree-sitter incremental parsing (C# + F#), salsa cache, request routing, sidecar lifecycle
- **Tier 2 — C# Sidecar (Roslyn)**: Long-running .NET process, MSBuildWorkspace, full Roslyn API (completions, diagnostics, refactorings, formatting)
- **Tier 3 — F# Sidecar (FCS)**: Long-running .NET process, FSharpChecker, Ionide.ProjInfo, Fantomas, FSharpLint

IPC: MessagePack over named pipes (Windows) / Unix domain sockets (Linux, macOS).

C# and F# are equal first-class citizens.

## Repository Structure

```
forge/
├── src/                  # Rust LSP host
├── sidecars/
│   ├── Forge.Sidecar.FSharp/   # F# sidecar (FSharp.Compiler.Service)
│   ├── Forge.Sidecar.CSharp/   # C# sidecar (Roslyn)
│   ├── Forge.Sidecar.Common/   # Shared sidecar code
│   └── Forge.Sidecars.sln
├── editors/
│   └── vscode/           # VS Code extension
├── docs/
│   ├── specs/            # Specifications — how functionality works
│   ├── plans/            # Implementation plans — how we build it (with TODOs)
│   └── DESIGN-SYSTEM.md
├── examples/             # Example files for testing
├── tests/                # E2E tests
├── website/              # Project website
├── .devcontainer/        # Dev container configuration
└── forge.example.toml    # Example configuration
```

## Documentation

All documentation lives in `docs/`.

- **Specs** (`docs/specs/`): Specifications that describe **how functionality works**. These are the source of truth for feature behavior, protocols, and architecture. Naming convention: `[COMPONENT]-[FEATURE]-SPEC.md`.

- **Plans** (`docs/plans/`): Implementation plans that describe **how we are going to build it**. Each plan includes TODO checklists tracking progress toward the spec. Naming convention: `[COMPONENT]-[FEATURE]-PLAN.md`.

The key spec is `docs/specs/FORGE-SPEC.md` — the full technical specification for the project.

## License

[MIT](LICENSE)
