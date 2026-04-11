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

## Install

Install the LSP binary and sidecars once; every editor picks them up from `$PATH`.

```sh
make install        # forge-lsp → ~/.local/bin, sidecars → ~/.local/lib/forge
```

### VS Code

```sh
make build-vsix
code --install-extension forge.vsix
```

### Zed

Zed compiles extensions from source at install time, so `package-zed` stages a self-contained source tree you point Zed at.

```sh
rustup target add wasm32-wasip1   # one-off
make package-zed                  # stages target/zed-extension/ + forge-zed-extension.tar.gz
```

Then in Zed: command palette → `zed: install dev extension` → pick `target/zed-extension/` (absolute path). Zed builds the wasm and loads it. Re-run `make package-zed` and hit **Rebuild** to iterate.

Full `forge-lsp` (hover, completions, go-to-def, diagnostics, rename, …) works in Zed over stdio. The `/forge-tree <Solution.sln>` slash command renders the solution tree in the assistant. A sidebar Solution Explorer is not possible — Zed's extension API has no panel/tree-view/webview contribution point.

### JetBrains Rider

```sh
make package-rider        # requires JDK 21 (brew install openjdk@21)
```

Then in Rider: **Settings → Plugins → ⚙ → Install Plugin from Disk…** and pick `forge-rider.zip`. Restart. The plugin attaches `forge-lsp` over LSP for `.cs/.csx/.fs/.fsx/.fsi` and adds a **Forge Solution** tool window that mirrors the VS Code solution explorer (projects, NuGet packages, project references, namespaces, types, members — all via the same `forge/*` custom LSP requests).

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
│   ├── vscode/           # VS Code extension (TypeScript)
│   └── zed/              # Zed extension (Rust → wasm32-wasip1)
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
