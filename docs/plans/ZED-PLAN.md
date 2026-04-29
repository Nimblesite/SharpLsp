# Zed Extension Plan

**Status:** Active
**Last Updated:** 2026-03-22

## Overview

Zed extension for SharpLsp — the open-source .NET LSP. Provides sharplsp-lsp integration for C# and F# development in Zed, plus a solution tree slash command for AI-assisted workflows.

## Architecture

```
Zed Editor
  └── SharpLsp Extension (Rust → WASM)
        ├── Language Server Adapter
        │     └── sharplsp-lsp binary (stdio JSON-RPC)
        └── Slash Commands
              └── /sharplsp-tree → .sln/.csproj/.fsproj parsing
```

The extension compiles to `wasm32-wasip1` and runs in Zed's WASM sandbox. It cannot access the filesystem directly — all file reads go through the `Worktree` API.

## VS Code Feature Parity Matrix

| VS Code Feature | Zed Status | Implementation |
|----------------|------------|----------------|
| LSP client (C# + F#) | Done | `language_server_command()` in lib.rs |
| Server binary resolution (PATH) | Done | `resolve_binary()` with caching |
| Server environment (RUST_LOG) | Done | `build_server_env()` inherits shell env |
| Solution tree (project structure) | Done | `/sharplsp-tree` slash command |
| Solution tree (NuGet packages) | Done | .csproj/.fsproj XML parsing |
| Solution tree (project references) | Done | .csproj/.fsproj XML parsing |
| Solution tree (symbol hierarchy) | Blocked | Requires Zed custom panel API |
| Solution tree (namespace merging) | Blocked | Requires Zed custom panel API |
| Solution tree (click-to-navigate) | Blocked | Requires Zed custom panel API |
| Solution tree (hover tooltips) | Blocked | Requires Zed custom panel API |
| Sort modes (natural/alpha/access) | Blocked | Requires Zed custom panel API |
| Status bar indicator | Blocked | Zed has no extension status bar API |
| Restart server command | N/A | Zed manages LSP lifecycle natively |
| Output/trace channels | N/A | Zed has built-in LSP log viewer |
| Select solution dialog | Partial | Slash command takes path argument |
| Remove NuGet package | Blocked | Requires Zed command/UI API |
| Remove project reference | Blocked | Requires Zed command/UI API |
| Document symbols outline | Free | Zed outline panel + sharplsp-lsp documentSymbol |
| Semantic tokens | Free | Zed renders LSP semantic tokens natively |
| Auto-refresh on file change | Free | Zed re-queries LSP on file change |

### Zed Platform Limitations

Zed extensions (as of 2026-03) cannot:

1. **Create custom panels or tree views** — no equivalent to VS Code's `TreeDataProvider`
2. **Add status bar items** — no extension API for the status bar
3. **Register editor commands** — no command palette contributions from extensions
4. **Show dialogs/quick picks** — no modal UI from extensions
5. **Access LSP client from slash commands** — slash commands run independently of the LSP

These are tracked upstream: [zed-industries/extensions#1288](https://github.com/zed-industries/extensions/issues/1288)

When Zed adds custom panel support, the solution tree should be migrated from slash command to a native panel.

## File Structure

```
editors/zed/
├── extension.toml      Extension manifest (language server + slash commands)
├── Cargo.toml          Rust project (compiles to cdylib → WASM)
└── src/
    ├── lib.rs           Extension entry point, LSP adapter, command routing
    ├── solution.rs      .sln file parsing (project extraction)
    ├── project.rs       .csproj/.fsproj parsing (dependencies)
    └── tree.rs          Text tree formatting for slash command output
```

## Building

```bash
# Native check (development)
cd editors/zed && cargo check

# WASM build (release)
cd editors/zed && cargo build --release --target wasm32-wasip1

# Run tests
cd editors/zed && cargo test
```

Requires `rustup target add wasm32-wasip1` for WASM builds.

## Key Decisions

1. **Standalone workspace** — The Zed extension has its own `[workspace]` in Cargo.toml because it targets wasm32-wasip1, not the native target used by sharplsp-lsp.

2. **No grammar/highlights** — The extension does not bundle tree-sitter grammars or highlight queries. Users should install the existing C# Zed extension for syntax highlighting. SharpLsp provides the language server, not the grammar.

3. **Slash command for solution tree** — Since Zed lacks custom panels, the solution tree is exposed via `/sharplsp-tree <path>` in the AI assistant. This injects solution structure as context for AI-assisted development.

4. **No serde dependency** — The extension uses only `zed_extension_api` (which re-exports `serde_json`). XML parsing of .csproj/.fsproj files uses simple string matching rather than a full XML parser, keeping the WASM binary small.

## TODOs

### Phase 1: Core (Done)

- [x] Extension manifest (`extension.toml`)
- [x] Cargo project setup (standalone workspace, cdylib)
- [x] LSP server binary resolution (PATH lookup with caching)
- [x] Server environment configuration (RUST_LOG from shell env)
- [x] `/sharplsp-tree` slash command
- [x] .sln file parsing (project extraction, path normalization)
- [x] .csproj/.fsproj parsing (NuGet packages, project references)
- [x] Tree text formatting (box-drawing characters)
- [x] Unit tests for all parsing and formatting (15 tests)

### Phase 2: Enhanced Solution Tree

- [ ] Auto-discover .sln files (try `{root_name}.sln` when no arg given)
- [ ] Slash command argument completion (suggest discovered .sln files)
- [ ] Include source file listing in tree output
- [ ] Include target framework in project display
- [ ] Include output type (exe/lib) in project display
- [ ] Parse solution folders from .sln and display hierarchy

### Phase 3: Settings and Configuration

- [ ] Read `sharplsp.lspPath` from Zed settings for custom binary location
- [ ] Read `sharplsp.logging.level` from Zed settings for RUST_LOG
- [ ] Pass extra CLI args to sharplsp-lsp from settings
- [ ] Send initialization options (solution path) to sharplsp-lsp
- [ ] Workspace configuration passthrough from Zed settings

### Phase 4: Symbol Integration

- [ ] `/sharplsp-symbols` slash command — query `sharplsp/workspaceSymbols` via LSP
  (blocked: slash commands cannot access LSP client in current Zed API)
- [ ] Custom symbol labels via `labels_for_symbols()`
- [ ] Custom completion labels via `labels_for_completions()`
- [ ] Enhanced outline display for .NET symbol kinds

### Phase 5: Zed Custom Panel (Blocked on Zed API)

- [ ] Migrate solution tree from slash command to native panel
- [ ] Click-to-navigate on symbol nodes
- [ ] Hover tooltips via LSP `textDocument/hover`
- [ ] Sort modes: natural, alphabetical, accessibility
- [ ] Namespace merging across files
- [ ] Dependency management (remove package/reference)
- [ ] Auto-refresh on C#/F# file changes (debounced)
- [ ] Status bar indicator (server state)

### Phase 6: Language Support

- [ ] Bundle tree-sitter-c-sharp grammar
- [ ] Bundle tree-sitter-fsharp grammar
- [ ] C# highlights.scm query
- [ ] F# highlights.scm query
- [ ] C# outline.scm query (enhanced outline panel)
- [ ] F# outline.scm query
- [ ] C# brackets.scm / indents.scm
- [ ] F# brackets.scm / indents.scm
- [ ] Language config.toml files (comments, brackets, indentation)

### Phase 7: Testing and CI

- [ ] E2E test harness (launch Zed with extension, open .sln workspace)
- [ ] CI pipeline: `cargo check --target wasm32-wasip1`
- [ ] CI pipeline: `cargo test`
- [ ] CI pipeline: `cargo clippy`
- [ ] WASM binary size optimization
- [ ] Publish to Zed extension registry

### Phase 8: Parity Polish

- [ ] Debugger integration (DAP support via Zed's debugger API)
- [ ] Snippet support for C# and F# common patterns
- [ ] MCP server integration for AI-powered .NET workflows
- [ ] Theme contributions (SharpLsp-branded dark/light themes)
