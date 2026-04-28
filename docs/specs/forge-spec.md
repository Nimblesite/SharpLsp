# FORGE

**The .NET Language Server Platform**

**TECHNICAL SPECIFICATION v0.1**

C# + F# | Editor-Agnostic | Rust-Hosted | Open Source

*March 2026 | DRAFT*

## 1. Mission Statement

Forge is an open-source, editor-agnostic [Language Server Protocol (LSP)](https://microsoft.github.io/language-server-protocol/) implementation for the .NET ecosystem, written in Rust, targeting feature parity with and superiority over Visual Studio, [JetBrains Rider](https://www.jetbrains.com/rider/), and [C# Dev Kit](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit) across both C# and F# as equal first-class citizens.

Forge exists because .NET developers deserve world-class tooling that is not gated behind proprietary licenses, vendor lock-in, or single-editor coupling. Every .NET developer, in every editor, on every platform, should have access to the best possible development experience.

### 1.1 Design Principles

- **Editor-agnostic:** Pure [LSP 3.17+](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) protocol. No editor-specific APIs. Works in [VS Code](https://code.visualstudio.com/), [Neovim](https://neovim.io/), [Helix](https://helix-editor.com/), [Zed](https://zed.dev/), [Emacs](https://www.gnu.org/software/emacs/), [Sublime](https://www.sublimetext.com/), or any LSP-capable editor.

- **C# and F# are equals:** F# is not a second-class citizen bolted on later. Both languages share infrastructure, both hit feature parity targets, both are tested to the same standard.

- **Zero proprietary dependencies:** The only Microsoft components are the open-source, MIT-licensed [Roslyn compiler](https://github.com/dotnet/roslyn) and [F# Compiler Services](https://fsharp.github.io/fsharp-compiler-docs/). No Visual Studio licensing. No C# Dev Kit EULA.

- **Rust for the hot path:** Protocol handling, document management, syntax parsing, request routing, and caching all happen in Rust for maximum throughput and minimum latency.

- **Correctness over cleverness:** Semantic analysis is delegated to the official compilers via managed sidecar processes. We do not reimplement type checkers.

- **Crush the incumbents:** Not approximate parity. Not a lightweight alternative. Full feature-for-feature superiority. Every refactoring Rider has. Every code fix Visual Studio has. Every diagnostic, every navigation feature.

### 1.2 Competitive Position

Forge targets three incumbents simultaneously:

| Target | Weakness Forge Exploits |
|---|---|
| Visual Studio | Windows-only, monolithic, closed-source IDE. Features locked behind full IDE installation. No LSP for external editors. |
| JetBrains Rider | Proprietary, paid license ($169–$399/yr). Uses custom protocol, not LSP. Dual-process JVM/.NET architecture is resource-heavy. |
| C# Dev Kit | VS Code-only. Proprietary license for teams >5. No F# support. Custom non-standard LSP extensions cause breakage in other editors. |

## 2. Architecture

### 2.1 High-Level Architecture

Forge uses a three-tier architecture: a Rust host process handles the LSP protocol and syntax-level analysis, communicating with two managed .NET sidecar processes (one for C#/[Roslyn](https://github.com/dotnet/roslyn), one for F#/[FCS](https://fsharp.github.io/fsharp-compiler-docs/)) that perform all semantic analysis. This is not a compromise — it is the optimal design, validated by Visual Studio's own ServiceHub architecture and [FsAutoComplete](https://github.com/fsharp/FsAutoComplete)'s production deployment.

**Tier 1 — Rust LSP Host**

- Owns the LSP connection ([JSON-RPC](https://www.jsonrpc.org/specification) over stdio)
- Maintains the authoritative Virtual File System (VFS) with document state
- Runs [tree-sitter](https://tree-sitter.github.io/tree-sitter/) incremental parsing for both C# and F# (sub-millisecond re-parses)
- Hosts the [salsa](https://salsa-rs.github.io/salsa/) incremental computation database for caching and dependency tracking
- Routes requests: syntax-only requests are handled locally; semantic requests are dispatched to sidecars
- Manages sidecar lifecycle: spawn, health monitoring, crash recovery, graceful shutdown
- Coalesces rapid-fire requests, cancels stale in-flight requests, prioritizes interactive features

**Tier 2 — C# Sidecar (Roslyn)**

- Long-running .NET process hosting [Microsoft.CodeAnalysis](https://www.nuget.org/packages/Microsoft.CodeAnalysis) v5.3.0+
- [MSBuildWorkspace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.msbuild.msbuildworkspace) for project/solution loading via design-time builds
- Full Roslyn API surface: [CompletionService](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.completion.completionservice), [SymbolFinder](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.findusages.symbolfinder), [Renamer](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.rename.renamer), CodeFixProviders, [Classifier](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.classification.classifier)
- Incremental compilation via Roslyn's immutable snapshot model (Solution → Project[] → Document[])
- Custom RPC interface over named pipes / Unix domain sockets with [MessagePack](https://msgpack.org/) serialization

**Tier 3 — F# Sidecar (FCS)**

- Long-running .NET process hosting [FSharp.Compiler.Service](https://www.nuget.org/packages/FSharp.Compiler.Service) v43.12+
- [FSharpChecker](https://fsharp.github.io/fsharp-compiler-docs/reference/fsharp-compiler-codeanalysis-fsharpchecker.html) with incremental build caching (MRU caches for parse/check results)
- [Ionide.ProjInfo](https://github.com/ionide/proj-info) for project cracking (MSBuild evaluation for F# projects)
- [FSharpLint](https://github.com/fsprojects/FSharpLint) for linting
- Same RPC interface and transport as C# sidecar for architectural symmetry

### 2.2 IPC Transport Protocol

Communication between the Rust host and .NET sidecars uses a custom binary RPC protocol:

| Property | Specification |
|---|---|
| Transport | Named pipes (Windows) / Unix domain sockets (Linux, macOS) |
| Serialization | [MessagePack](https://msgpack.org/) via [rmp-serde](https://crates.io/crates/rmp-serde) (Rust) and [MessagePack-CSharp](https://github.com/MessagePack-CSharp/MessagePack-CSharp) (.NET) |
| Framing | 4-byte little-endian length prefix + MessagePack payload |
| Concurrency | Request IDs for multiplexed async request/response + server-initiated notifications |
| Cancellation | Dedicated cancel notification matching LSP `$/cancelRequest` semantics |
| Performance target | <500µs round-trip overhead (excluding compiler work) |

MessagePack was chosen over JSON-RPC because it is 2.3x faster to serialize and 57% smaller on the wire, and because Roslyn's own out-of-process ServiceHub uses MessagePack in production, proving it works at IDE scale.

### 2.3 Request Routing Strategy

The Rust host classifies every incoming LSP request and routes it to the fastest handler:

| Category | Handler | Latency Target | Examples |
|---|---|---|---|
| Syntax-only | Rust (tree-sitter) | <5ms | documentSymbol, foldingRange, selectionRange, linkedEditingRange |
| Semantic | Sidecar (Roslyn/FCS) | <200ms | completion, hover, definition, references, rename, codeAction, diagnostics |
| Hybrid | Rust + Sidecar | <100ms | semanticTokens (tree-sitter for structure, sidecar for classification) |
| Cached | Rust (salsa cache) | <1ms | Repeat requests for unchanged documents |

Key optimization: on every keystroke, tree-sitter re-parses in <1ms and provides immediate feedback for syntax-level features, while semantic requests are coalesced with a debounce window (default 150ms) before dispatching to sidecars. Stale in-flight semantic requests are cancelled when superseded.

### 2.4 Sidecar Lifecycle Management

- **Startup:** Sidecars are spawned lazily on first request for their language. Published as self-contained single-file executables (AOT is incompatible with Roslyn, FSharp.Compiler.Service, and other reflection-heavy dependencies).
- **Health monitoring:** Periodic heartbeat pings (every 5s). If a sidecar fails to respond within 2s, it is marked unhealthy.
- **Crash recovery:** On sidecar death, cache last-known-good results for graceful degradation. Restart with exponential backoff (1s, 2s, 4s, max 30s). Notify editor via LSP `window/showMessage`.
- **Isolation:** C# and F# sidecars are independent processes. A Roslyn OOM does not affect FCS, and vice versa.
- **Shutdown:** On LSP `shutdown` notification, send cancellation to sidecars, wait up to 5s for graceful exit, then SIGKILL.

### 2.5 Project System

The project system is the hardest engineering problem in .NET tooling. [MSBuild](https://learn.microsoft.com/en-us/visualstudio/msbuild/msbuild) project files are Turing-complete, and correct evaluation requires handling SDK-style projects, legacy .csproj/.fsproj, multi-targeting, [Directory.Build.props](https://learn.microsoft.com/en-us/visualstudio/msbuild/customize-by-directory), [Directory.Packages.props](https://learn.microsoft.com/en-us/nuget/consume-packages/central-package-management) (Central Package Management), [global.json](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json) SDK pinning, conditional compilation symbols, and NuGet package resolution.

**Forge's approach:**

- **C# projects:** [MSBuildWorkspace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.msbuild.msbuildworkspace) ([Microsoft.CodeAnalysis.Workspaces.MSBuild](https://www.nuget.org/packages/Microsoft.CodeAnalysis.Workspaces.MSBuild) + [Microsoft.Build.Locator](https://github.com/microsoft/MSBuildLocator)) performs design-time builds to extract source files, references, and compiler options.
- **F# projects:** [Ionide.ProjInfo](https://github.com/ionide/proj-info) performs MSBuild evaluation with F#-specific handling (file ordering, which is semantically significant in F#).
- **Mixed solutions:** Both sidecars load their respective projects from the same `.sln` or `.slnx` solution file. Cross-language project references are resolved via binary reference (compiled DLL), not source-level.
- **Solution files:** Forge treats legacy `.sln` and XML `.slnx` as first-class solution inputs. Shared sidecar code reads both formats through `Microsoft.VisualStudio.SolutionPersistence` and exposes a neutral `solution/read` DTO so host/editor code does not parse solution text.
- **File watching:** The Rust host watches .csproj, .fsproj, .sln, .slnx, Directory.Build.props, Directory.Packages.props, NuGet.config, and global.json for changes. On change, the affected sidecar is notified to reload the project model.
- **Multi-targeting:** Projects targeting multiple TFMs (e.g., `net8.0;net48;netstandard2.0`) present multiple analysis contexts. Forge exposes a custom LSP extension for users to select the active TFM, defaulting to the first.

### 2.6 Binary Layout & Installation

**ALL Forge binaries live in ONE central location on the machine. NEVER inside an editor extension.** Every editor (VS Code, Zed, Neovim, Helix, etc.) finds `forge-lsp` on `$PATH`. Extensions are thin clients that launch the system-installed binaries. **Extensions contain ZERO binaries.**

**Install locations (PREFIX defaults to `~/.local`):**

| Artifact | Install Path | Purpose |
|---|---|---|
| `forge-lsp` | `$(PREFIX)/bin/forge-lsp` | Rust LSP server binary (MUST be on `$PATH`) |
| C# sidecar | `$(PREFIX)/lib/forge/sidecar-csharp/` | Self-contained single-file executable |
| F# sidecar | `$(PREFIX)/lib/forge/sidecar-fsharp/` | Self-contained single-file executable |

```
~/.local/
├── bin/
│   └── forge-lsp                          (on $PATH)
└── lib/forge/
    ├── sidecar-csharp/
    │   └── Forge.Sidecar.CSharp          (self-contained executable)
    └── sidecar-fsharp/
        └── Forge.Sidecar.FSharp          (self-contained executable)
```

`$(PREFIX)/bin` MUST be on `$PATH`. This is non-negotiable.

**Who installs binaries:**

- **`make install`** — builds from source and copies to the standard locations above. Primary install for developers building from source.
- **Editor extensions** — download pre-built binaries from GitHub releases and install to the same standard locations. This is the primary install path for end users.
- **Manual download** — users can download release archives and extract to the standard locations.

All three methods install to the SAME locations. One install serves every editor on the machine.

**Version checking (`--version` flag):**

All three binaries support `--version` and print their version to stdout:

```
$ forge-lsp --version
forge-lsp 0.1.0

$ Forge.Sidecar.CSharp --version
forge-sidecar-csharp 0.1.0

$ Forge.Sidecar.FSharp --version
forge-sidecar-fsharp 0.1.0
```

Extensions use this to verify the correct version is installed before starting.

**Sidecar resolution by the Rust host (two-step fallback):**

1. **Installed:** `<exe_dir>/../lib/forge/sidecar-csharp/Forge.Sidecar.CSharp` — launched directly as native executable (no `dotnet` required)
2. **Dev build:** `dotnet run --project sidecars/Forge.Sidecar.CSharp` — requires CWD = repo root

### 2.7 Editor Extension Binary Strategy

**Extensions contain NO binaries. Extensions are THIN CLIENTS.** They exist solely to integrate with the editor's UI and launch `forge-lsp` from `$PATH`.

On activation, every editor extension follows this exact sequence:

1. **Version check:** Run `forge-lsp --version` to check if forge-lsp is installed and what version it is. The output format is `forge-lsp X.Y.Z` — the version is always the second whitespace-delimited token. Extensions parse this deterministically.
2. **Version match:** If the installed version matches the extension's expected version, start normally. Done.
3. **Missing or outdated:** Download the correct platform-specific archive from the GitHub release matching the extension version. Install `forge-lsp` to `$(PREFIX)/bin/` and sidecars to `$(PREFIX)/lib/forge/`. Then start normally.
4. **Download fails:** Surface an error to the user with maximum urgency. Do NOT silently degrade. Do NOT fall back to some partial mode. The extension CANNOT function without the binaries. Tell the user exactly what went wrong and how to fix it (manual download link, `make install` instructions, etc.).

**CRITICAL — Failure must NEVER lock up the editor:**

When any step above fails — version mismatch, binary not found, download failed, `--version` returns garbage — the extension MUST:

- Show a clear, user-facing error message explaining what happened and how to fix it (e.g., "Forge: forge-lsp v0.1.0 required but v0.0.9 found. Run `make install` or update the extension.")
- Deactivate gracefully — dispose all resources, unregister providers, stop any pending operations
- NEVER throw an unhandled exception that propagates to the editor host process
- NEVER block the editor's main thread or event loop waiting for a binary that will never arrive
- NEVER leave the extension in a half-initialized zombie state where it eats CPU or holds locks

This applies to ALL editor extensions: VS Code, Zed, Neovim, Helix, etc. An extension that locks up the editor because the binary version is wrong is a critical bug of the highest severity.

**Version contract:**

| Component | Version source | `--version` output format |
|---|---|---|
| `forge-lsp` | `Cargo.toml` via `env!("CARGO_PKG_VERSION")` | `forge-lsp X.Y.Z` |
| C# sidecar | `.csproj` AssemblyVersion | `forge-sidecar-csharp X.Y.Z` |
| F# sidecar | `.fsproj` AssemblyVersion | `forge-sidecar-fsharp X.Y.Z` |
| VS Code ext | `package.json` version field | N/A (not a CLI) |
| Zed ext | `extension.toml` version field | N/A (not a CLI) |

All versions MUST be kept in sync across all components. A release tags all components at the same version. Extensions MUST check the binary version matches their own version before starting the server.

**Test requirements:**

Every editor extension MUST have e2e tests that prove:
1. `forge-lsp --version` returns the correct format and version
2. When the version matches, the extension starts the server successfully
3. When the version mismatches, the extension shows a user-facing error and does NOT freeze the editor
4. When the binary is missing, the extension shows a user-facing error and does NOT freeze the editor

The Rust binary MUST have a test that proves:
1. `--version` prints the correct format: `forge-lsp X.Y.Z` where X.Y.Z matches `Cargo.toml`
2. The process exits with code 0

This is editor-agnostic by design. One set of binaries serves VS Code, Zed, Neovim, Helix, and any future editor. A user who runs `make install` already has everything every extension needs. An extension that auto-installs binaries provides them for every other extension too.

## 3. Technology Stack

### 3.1 Rust Host Crates

| Crate | Version | Purpose |
|---|---|---|
| [lsp-server](https://crates.io/crates/lsp-server) | 0.7.9 | LSP event loop and message dispatch ([rust-analyzer](https://github.com/rust-lang/rust-analyzer)'s own scaffold) |
| [lsp-types](https://crates.io/crates/lsp-types) | 0.97.0 | LSP 3.17 protocol type definitions |
| [salsa](https://crates.io/crates/salsa) | 0.24.0 | Incremental computation framework (memoized queries, dependency tracking) |
| [tree-sitter](https://crates.io/crates/tree-sitter) | 0.24.x | Incremental parsing runtime |
| [tree-sitter-c-sharp](https://github.com/tree-sitter/tree-sitter-c-sharp) | 0.23.1 | C# grammar (C# 1–13, based on Roslyn grammar) |
| [tree-sitter-fsharp](https://github.com/ionide/tree-sitter-fsharp) | latest | F# grammar |
| [interprocess](https://crates.io/crates/interprocess) | latest | Named pipes / Unix domain sockets |
| [rmp-serde](https://crates.io/crates/rmp-serde) | 1.3.1 | MessagePack serialization with [serde](https://serde.rs/) |
| [tokio](https://tokio.rs/) | 1.x | Async runtime for non-blocking I/O |
| [serde](https://serde.rs/) / [serde_json](https://crates.io/crates/serde_json) | 1.x | JSON handling for LSP protocol |
| [tracing](https://crates.io/crates/tracing) | 0.1.x | Structured logging with [OpenTelemetry](https://opentelemetry.io/) export |
| [notify](https://crates.io/crates/notify) | 7.x | Cross-platform filesystem watcher |
| [dashmap](https://crates.io/crates/dashmap) | 6.x | Concurrent hash map for shared caches |

### 3.2 C# Sidecar Packages

| Package | Version | Purpose |
|---|---|---|
| [Microsoft.CodeAnalysis](https://www.nuget.org/packages/Microsoft.CodeAnalysis) | 5.3.0 | Roslyn compiler platform (syntax, semantic model, diagnostics) |
| [Microsoft.CodeAnalysis.CSharp.Workspaces](https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp.Workspaces) | 5.3.0 | C# workspace services |
| [Microsoft.CodeAnalysis.CSharp.Features](https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp.Features) | 5.3.0 | IDE features: completions, code fixes, refactorings |
| [Microsoft.CodeAnalysis.Workspaces.MSBuild](https://www.nuget.org/packages/Microsoft.CodeAnalysis.Workspaces.MSBuild) | 5.0.0 | MSBuild project/solution loading |
| [Microsoft.Build.Locator](https://github.com/microsoft/MSBuildLocator) | latest | MSBuild installation discovery |
| [ICSharpCode.Decompiler](https://github.com/icsharpcode/ILSpy/tree/master/ICSharpCode.Decompiler) | latest | Decompiled metadata source navigation |
| [MessagePack-CSharp](https://github.com/MessagePack-CSharp/MessagePack-CSharp) | latest | IPC serialization |

### 3.3 F# Sidecar Packages

| Package | Version | Purpose |
|---|---|---|
| [FSharp.Compiler.Service](https://www.nuget.org/packages/FSharp.Compiler.Service) | 43.12.201 | F# compiler services (parsing, type checking, IDE features) |
| [Ionide.ProjInfo](https://github.com/ionide/proj-info) | latest | F# project cracking (MSBuild evaluation) |
| [FSharpLint.Core](https://github.com/fsprojects/FSharpLint) | latest | F# linting diagnostics |
| [FSharp.Analyzers.SDK](https://github.com/ionide/FSharp.Analyzers.SDK) | latest | Third-party F# analyzer support |
| [MessagePack-CSharp](https://github.com/MessagePack-CSharp/MessagePack-CSharp) | latest | IPC serialization |

## 4. Feature Specification

This section specifies every feature Forge will implement, mapped to the LSP protocol method, implementation source, and the Roslyn/FCS API that powers it. Features are organized by category. Both C# and F# columns indicate full support unless otherwise noted.

### 4.1 Code Intelligence

| Feature | LSP Method | C# API (Roslyn) | F# API (FCS) | Priority |
|---|---|---|---|---|
| Auto-completion | `textDocument/completion` | [CompletionService.GetCompletionsAsync()](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.completion.completionservice.getcompletionsasync) | GetDeclarationListInfo() | P0 |
| Completion resolve | `completionItem/resolve` | [CompletionService.GetDescriptionAsync()](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.completion.completionservice.getdescriptionasync) | GetDeclarationListInfo (detail) | P0 |
| Hover / Quick Info | `textDocument/hover` | See [HOVER-SPEC.md](HOVER-SPEC.md) | See [HOVER-SPEC.md](HOVER-SPEC.md) | P0 |
| Signature help | `textDocument/signatureHelp` | SignatureHelpService.GetItemsAsync() | GetMethods() | P0 |
| Parameter hints | `textDocument/signatureHelp` | Same (active parameter tracking) | Same (active parameter tracking) | P0 |
| Inlay hints (types) | `textDocument/inlayHint` | Type inference display | Type inference display | P1 |
| Inlay hints (params) | `textDocument/inlayHint` | Parameter name hints | Parameter name hints | P1 |
| Inline values | `textDocument/inlineValue` | Debugger expression eval | Debugger expression eval | P2 |

### 4.2 Navigation

| Feature | LSP Method | C# API (Roslyn) | F# API (FCS) | Priority |
|---|---|---|---|---|
| Go to definition | See [DEFINITION-SPEC.md](DEFINITION-SPEC.md) | | | P0 |
| Go to declaration | See [DEFINITION-SPEC.md](DEFINITION-SPEC.md) | | | P0 |
| Go to type definition | See [DEFINITION-SPEC.md](DEFINITION-SPEC.md) | | | P0 |
| Go to implementation | See [DEFINITION-SPEC.md](DEFINITION-SPEC.md) | | | P0 |
| Find all references | `textDocument/references` | [SymbolFinder.FindReferencesAsync()](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.findusages.symbolfinder.findreferencesasync) | GetUsesOfSymbolInFile/Project() | P0 |
| Document highlights | `textDocument/documentHighlight` | SymbolFinder (scoped to doc) | GetUsesOfSymbolInFile() | P0 |
| Workspace symbol search | `workspace/symbol` | SymbolFinder (project-wide) | GetAllUsesOfAllSymbols() | P0 |
| Document symbols | `textDocument/documentSymbol` | tree-sitter structural extraction | tree-sitter structural extraction | P0 |
| Call hierarchy | `textDocument/prepareCallHierarchy` | SymbolFinder.FindCallersAsync() | Custom call graph analysis | P1 |
| Type hierarchy | `textDocument/prepareTypeHierarchy` | FindDerivedClasses + base types | Type hierarchy via FCS symbols | P1 |
| Breadcrumbs | `textDocument/documentSymbol` | Hierarchical symbol tree | Hierarchical symbol tree | P1 |
| Go to decompiled source | Custom: `forge/decompileSource` | [ICSharpCode.Decompiler](https://github.com/icsharpcode/ILSpy) | ICSharpCode.Decompiler | P1 |
| Go to source generator output | Custom: `forge/generatorOutput` | GeneratorDriverRunResult | N/A | P2 |

### 4.3 Diagnostics & Analysis

Forge uses the LSP 3.17 **pull-diagnostics + workspace-refresh** model (`textDocument/diagnostic`, `workspace/diagnostic`, `workspace/diagnostic/refresh`), mirroring `Microsoft.CodeAnalysis.LanguageServer` (the engine behind C# Dev Kit). The Rust host never proactively pushes errors during workspace load — that is the only architecture that produces correct diagnostics while NuGet restore, source generators, and cross-project `CompilationReference`s are still resolving. A NuGet restore gate runs before `MSBuildWorkspace.OpenSolutionAsync` to eliminate the largest class of phantom CS0246s.

See [DIAGNOSTICS-SPEC.md](DIAGNOSTICS-SPEC.md) for the full specification, including the pull + refresh cycle, the NuGet restore gate, project filtering, and the truth guarantees Forge makes (and doesn't make) about diagnostic completeness during workspace load.

### 4.4 Code Actions & Refactoring

This is where Forge must match Rider's 2,200+ inspections and 60+ refactorings. Roslyn provides a substantial base of [CodeFixProviders](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.codefixes.codefixprovider) and [CodeRefactoringProviders](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.coderefactorings.coderefactoringprovider) out of the box. Forge will expose all of them and add custom ones.

| Feature | LSP Method | C# API | F# API | Priority |
|---|---|---|---|---|
| Quick fixes (all Roslyn built-in) | `textDocument/codeAction` | CodeFixProvider registry | FSAC code fixes | P0 |
| Refactorings (all Roslyn built-in) | `textDocument/codeAction` | CodeRefactoringProvider registry | FSAC refactorings | P0 |
| Extract method | `textDocument/codeAction` | ExtractMethodCodeRefactoring | Custom implementation | P0 |
| Extract variable/constant | `textDocument/codeAction` | IntroduceVariableCodeRefactoring | Custom implementation | P0 |
| Extract interface | `textDocument/codeAction` | ExtractInterfaceRefactoring | Custom implementation | P1 |
| Inline variable/method | `textDocument/codeAction` | InlineMethodRefactoring | Custom implementation | P1 |
| Rename symbol | See [RENAME-SPEC.md](RENAME-SPEC.md) | [Renamer.RenameSymbolAsync()](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.rename.renamer.renamesymbolasync) | FCS rename support | P0 |
| Rename file to match type | `textDocument/codeAction` | Custom (sync filename ↔ type) | Custom (sync filename ↔ module) | P1 |
| Move type to file | `textDocument/codeAction` | MoveTypeRefactoring | Custom implementation | P1 |
| Generate constructor | `textDocument/codeAction` | GenerateConstructor fix | Custom implementation | P0 |
| Generate equals/hashcode | `textDocument/codeAction` | GenerateEqualsAndGetHashCode | Custom implementation | P1 |
| Generate interface impl | `textDocument/codeAction` | ImplementInterface fix | ImplementInterface fix | P0 |
| Generate override | `textDocument/codeAction` | GenerateOverrides | Custom implementation | P1 |
| Add using/open directive | `textDocument/codeAction` | AddImport CodeFix | AddOpen CodeFix (FSAC) | P0 |
| Organize usings/opens | `textDocument/codeAction` | OrganizeImports | Custom open sorting | P0 |
| Convert between expression forms | `textDocument/codeAction` | Various Roslyn refactorings | Pipeline ↔ function composition | P1 |
| Surround with (try/catch, if, etc.) | `textDocument/codeAction` | Custom surround providers | Custom surround providers | P1 |
| Change signature | `textDocument/codeAction` | ChangeSignatureRefactoring | Custom implementation | P2 |
| Introduce parameter | `textDocument/codeAction` | IntroduceParameter refactoring | Custom implementation | P2 |
| Make field/property | `textDocument/codeAction` | EncapsulateField refactoring | Custom implementation | P2 |
| Convert auto-prop ↔ full prop | `textDocument/codeAction` | Roslyn property conversion | N/A | P1 |
| Convert method ↔ property | `textDocument/codeAction` | Custom implementation | N/A | P2 |

### 4.5 Formatting

Forge does **not** provide document formatting. Use dedicated formatters:

- **C#**: [CSharpier](https://csharpier.com/) — the community-standard opinionated C# formatter
- **F#**: [Fantomas](https://github.com/fsprojects/fantomas) via the [Ionide](https://ionide.io/) extension — the standard F# formatter

These tools are excellent at what they do and there is no reason to duplicate their work inside an LSP server.

### 4.6 Semantic Highlighting

| Feature | LSP Method | C# API | F# API | Priority |
|---|---|---|---|---|
| Full semantic tokens | `textDocument/semanticTokens/full` | [Classifier.GetClassifiedSpans()](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.classification.classifier.getclassifiedspans) | GetSemanticClassification() | P0 |
| Delta semantic tokens | `textDocument/semanticTokens/full/delta` | Incremental classification | Incremental classification | P1 |
| Range semantic tokens | `textDocument/semanticTokens/range` | Classifier (range-scoped) | GetSemanticClassification (range) | P0 |

### 4.7 Code Lens

| Feature | LSP Method | C# API | F# API | Priority |
|---|---|---|---|---|
| Reference count | `textDocument/codeLens` | SymbolFinder.FindReferences() | GetUsesOfSymbol() | P1 |
| Implementation count | `textDocument/codeLens` | SymbolFinder.FindImplementations() | Custom implementation count | P1 |
| Test indicators | `textDocument/codeLens` | Test framework attribute detection | Test framework attribute detection | P1 |
| Run/debug test | `textDocument/codeLens` | Custom test runner integration | Custom test runner integration | P2 |
| Recent changes (git) | `textDocument/codeLens` | git log integration | git log integration | P3 |

### 4.8 Debugging (DAP Integration)

> **Full specification:** [DEBUGGING-SPEC.md](./DEBUGGING-SPEC.md)
>
> Forge delivers a fully open-source .NET debugging experience via [DAP](https://microsoft.github.io/debug-adapter-protocol/specification). Phase 4 uses [netcoredbg](https://github.com/Samsung/netcoredbg) (MIT) with a `DapRouter` layer in the Rust host for capability augmentation (logpoints, async call stack reconstruction, Hot Reload). Phase 5 replaces netcoredbg with a Forge-native C# Debug Sidecar (Tier 4) built on [ClrDebug](https://github.com/lordmilko/ClrDebug) + ICorDebug, achieving full feature parity with Microsoft's proprietary vsdbg.

### 4.9 Test Discovery & Execution

| Feature | Protocol | Implementation | Priority |
|---|---|---|---|
| Discover tests ([xUnit](https://xunit.net/), [NUnit](https://nunit.org/), [MSTest](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-intro)) | Custom: `forge/testDiscovery` | Test adapter protocol / [vstest](https://github.com/microsoft/vstest) | P1 |
| Run individual test | Custom: `forge/testRun` | `dotnet test --filter` | P1 |
| Run test class/namespace | Custom: `forge/testRun` | `dotnet test --filter` (scoped) | P1 |
| Debug individual test | DAP + `forge/testDebug` | Launch with debugger attached | P2 |
| Test results inline | `textDocument/codeLens` | Pass/fail indicators on test methods | P2 |
| Continuous testing | Custom: `forge/testWatch` | File watcher + selective re-run | P3 |
| Code coverage | Custom: `forge/coverage` | [coverlet](https://github.com/coverlet-coverage/coverlet) integration | P3 |
| F# [Expecto](https://github.com/haf/expecto)/[FsCheck](https://github.com/fscheck/FsCheck) support | Custom: `forge/testDiscovery` | Expecto test tree discovery | P1 |

### 4.10 Workspace Features

| Feature | LSP Method | Implementation | Priority |
|---|---|---|---|
| Solution/project loading | Custom: `forge/openSolution` | MSBuildWorkspace + Ionide.ProjInfo | P0 |
| Project dependency graph | Custom: `forge/projectGraph` | MSBuild project reference analysis | P1 |
| NuGet package search | Custom: `forge/nuget/search` | HTTP GET nuget.org v3 API, cross-ref installed | P2 |
| NuGet package versions | Custom: `forge/nuget/versions` | HTTP GET nuget.org flat container API | P2 |
| NuGet installed packages | Custom: `forge/nuget/installed` | `dotnet list <project> package --format json` | P2 |
| NuGet install package | Custom: `forge/nuget/install` | `dotnet add <project> package` + sidecar reload | P2 |
| NuGet uninstall package | Custom: `forge/nuget/uninstall` | `dotnet remove <project> package` + sidecar reload | P2 |
| Multi-TFM selection | Custom: `forge/targetFramework` | Active TFM switching per project | P1 |
| File watching & reload | `workspace/didChangeWatchedFiles` | [notify](https://crates.io/crates/notify) crate + sidecar reload | P0 |
| Workspace diagnostics (pull) | `workspace/diagnostic` + `workspace/diagnostic/refresh` | Solution-wide error analysis via LSP 3.17 pull model + 2000ms-debounced refresh; primary diagnostic path (see [DIAGNOSTICS-SPEC §1.1](DIAGNOSTICS-SPEC.md#11-the-pull--refresh-cycle)) | P0 |
| NuGet restore gate | (internal, before `workspace/open`) | `dotnet restore` if `obj/project.assets.json` is stale; eliminates phantom CS0246 for NuGet types ([DIAGNOSTICS-SPEC §6](DIAGNOSTICS-SPEC.md#6-nuget-restore-gate)) | P0 |
| Project init complete | Custom: `workspace/projectInitializationComplete` | Notification fired once per workspace open after restore + `MSBuildWorkspace.OpenSolutionAsync`; matches Roslyn LSP contract | P0 |
| Configuration | `workspace/didChangeConfiguration` | [.editorconfig](https://editorconfig.org/) + forge.toml | P0 |

### 4.11 F#-Specific Features

F# has unique language features that require dedicated support beyond what the shared infrastructure provides:

| Feature | LSP Method | Implementation | Priority |
|---|---|---|---|
| Pipeline hints | `textDocument/inlayHint` | FSAC pipelineHint | P1 |
| Signature file generation | Custom: `forge/fsharpSignature` | FCS signature generation | P1 |
| Union case generation | `textDocument/codeAction` | Generate match cases from DU | P1 |
| Record stub generation | `textDocument/codeAction` | Generate record field stubs | P1 |
| Open statement management | `textDocument/codeAction` | Auto-open + organize opens | P0 |
| Computation expression support | `textDocument/completion` | CE-aware completions | P1 |
| Type provider navigation | `textDocument/definition` | Type provider generated type nav | P2 |
| F# Interactive integration | Custom: `forge/fsi` | Send selection to FSI, evaluate | P2 |
| File ordering awareness | Custom: `forge/fileOrder` | Semantic file reorder suggestions | P1 |

## 5. Performance Requirements

| Metric | Target | Measurement Method |
|---|---|---|
| Cold start (first LSP response) | <3 seconds | Time from process launch to initialized response |
| Warm completion latency | <100ms (p50), <200ms (p95) | Time from keypress to completion list render |
| Hover latency | <150ms (p50), <300ms (p95) | Time from hover trigger to tooltip render |
| Go-to-definition latency | <100ms (p50), <250ms (p95) | Time from click/shortcut to navigation |
| Find references (1000-file solution) | <2 seconds | Time to enumerate all references |
| Diagnostic refresh on edit | <500ms | Time from keystroke to updated squiggles |
| Document symbol outline | <10ms | Time to render document symbol tree (tree-sitter) |
| Folding ranges | <5ms | Time to compute all folding ranges (tree-sitter) |
| Memory (medium solution, ~600K LOC) | <2GB Rust + <3GB sidecar | Resident set size under steady state |
| Memory (large solution, ~2M LOC) | <3GB Rust + <5GB sidecar | Resident set size under steady state |
| Incremental re-parse on keystroke | <1ms | tree-sitter incremental parse time |
| Sidecar crash recovery | <3 seconds | Time from crash detection to restored functionality |

## 6. Implementation Plan

### Phase 1: Protocol Skeleton & Syntax Features (Months 1–3)

**Goal:** A working LSP server that handles all syntax-level features for both C# and F#, with a VS Code extension as test harness.

**Deliverables:**

- Rust binary implementing [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) lifecycle (initialize, initialized, shutdown, exit)
- Full document synchronization (open, change, close, save) with VFS
- [tree-sitter](https://tree-sitter.github.io/tree-sitter/) integration for C# (v0.23.1) and F# ([ionide grammar](https://github.com/ionide/tree-sitter-fsharp))
- Document symbols, folding ranges, selection ranges, linked editing ranges from tree-sitter
- Basic syntax highlighting via tree-sitter queries
- VS Code extension that spawns the Rust binary via stdio
- CI/CD pipeline with cross-platform builds (Linux, macOS, Windows)
- Logging infrastructure via [tracing](https://crates.io/crates/tracing) crate with [OpenTelemetry](https://opentelemetry.io/) export

### Phase 2: Sidecar Integration & Core Semantics (Months 4–8)

**Goal:** Full semantic analysis for both languages. This is the phase where Forge becomes genuinely useful.

**Deliverables:**

- C# sidecar with MSBuildWorkspace, full project loading, design-time build evaluation
- F# sidecar with FSharpChecker, Ionide.ProjInfo, project cracking
- IPC protocol implementation (MessagePack over named pipes/UDS) with health monitoring
- Completions, hover, signature help for both C# and F#
- Go to definition, declaration, type definition, implementation for both languages
- Find all references, document highlights for both languages
- Compiler diagnostics (real-time squiggles) for both languages
- Rename symbol for every renameable C# and F# code element (see [RENAME-SPEC.md](RENAME-SPEC.md))
- Full semantic tokens (classification) for both languages
- [salsa](https://salsa-rs.github.io/salsa/) database for incremental caching of semantic results
- Request coalescing and cancellation

### Phase 3: Code Actions & Refactoring (Months 9–14)

**Goal:** Feature parity with C# Dev Kit for code actions. Approach Rider's refactoring depth.

**Deliverables:**

- All Roslyn built-in CodeFixProviders exposed via LSP code actions
- All Roslyn built-in CodeRefactoringProviders exposed via LSP code actions
- [FSAC](https://github.com/fsharp/FsAutoComplete) code fixes and refactorings for F#
- Extract method, extract variable, inline, move type, rename file
- Generate constructor, equals/hashcode, interface implementation, overrides
- Inlay hints (type inference, parameter names) for both languages
- Call hierarchy and type hierarchy
- Code lens (reference count, implementation count)
- Decompiled source navigation via [ICSharpCode.Decompiler](https://github.com/icsharpcode/ILSpy)

### Phase 4: Advanced Features & Ecosystem (Months 15–20)

**Goal:** Feature parity with Rider. Go beyond what any single tool offers today.

**Deliverables:**

- Solution-wide error analysis (SWEA equivalent)
- Test discovery and execution ([xUnit](https://xunit.net/), [NUnit](https://nunit.org/), [MSTest](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-intro), [Expecto](https://github.com/haf/expecto), [FsCheck](https://github.com/fscheck/FsCheck))
- [DAP](https://microsoft.github.io/debug-adapter-protocol/specification) integration for debugging — see [DEBUGGING-SPEC.md](./DEBUGGING-SPEC.md) (Phase 4: netcoredbg + DapRouter; Phase 5: Forge Debug Sidecar with full vsdbg parity)
- Workspace management (solution opening, project graph, NuGet management)
- F#-specific features: signature files, pipeline hints, FSI integration, file ordering
- Source generator output viewing
- Third-party analyzer support (NuGet analyzers for C#, [FSharp.Analyzers.SDK](https://github.com/ionide/FSharp.Analyzers.SDK) for F#)
- Multi-editor verification (Neovim, Helix, Zed, Emacs, Sublime)
- Hot reload support via [dotnet watch](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-watch)
- Performance optimization pass (memory budgets, cache eviction, lazy loading)
- Custom Rider-class inspections beyond Roslyn's built-in set

### Phase 5: Superiority (Months 21+)

**Goal:** Features no existing tool has. This is where Forge stops competing and starts leading.

**Stretch deliverables:**

- AI-assisted code actions (LLM-powered refactoring suggestions via [MCP](https://modelcontextprotocol.io/) or custom protocol)
- Cross-language navigation (C# ↔ F# within the same solution, via binary references initially, source-level eventually)
- Architecture analysis (dependency visualization, cyclic dependency detection, layer violation warnings)
- Performance profiling integration ([dotnet-trace](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-trace), [dotnet-counters](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-counters))
- Memory analysis integration ([dotnet-dump](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dump))
- Database-aware analysis (SQL-in-string validation, [EF Core](https://learn.microsoft.com/en-us/ef/core/) migration awareness)
- Collaborative editing support (operational transform / CRDT)

## 7. Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Roslyn Features APIs are internal | High | High | Use reflection for internal APIs. Contribute upstream PRs to make critical APIs public. Monitor Roslyn releases for API surface changes. |
| MSBuild evaluation complexity | High | Certain | Leverage MSBuildWorkspace (proven by [OmniSharp](https://github.com/OmniSharp/omnisharp-roslyn)). Build comprehensive test suite against real-world `.sln` and `.slnx` files. Handle failure gracefully with partial project loading. |
| Memory pressure in large solutions | High | Medium | Implement per-project sidecar pooling. Add memory budget enforcement with cache eviction. Consider separate sidecar instances per project in extreme cases. |
| F# tree-sitter grammar incomplete | Medium | Medium | Fall back to FCS for any syntax feature where tree-sitter produces incorrect results. Contribute upstream to improve the grammar. |
| Roslyn version coupling | Medium | Certain | Pin Roslyn version per Forge release. Test against multiple Roslyn versions in CI. Abstract sidecar RPC to isolate version dependencies. |
| Microsoft ships improvements to Roslyn LSP server | Low | High | Forge's value is unified C#+F#, editor-agnostic, open governance, and performance. These remain regardless of Microsoft's progress. |
| Adoption challenge | Medium | Medium | Ship early with partial features. Demonstrate clear value in editors Microsoft ignores (Neovim, Helix, Emacs). Build community around open governance. |

## 8. Licensing

Forge is MIT-licensed. All dependencies are compatible:

| Component | License | Restrictions |
|---|---|---|
| [Roslyn](https://github.com/dotnet/roslyn) (Microsoft.CodeAnalysis.*) | MIT | None. Explicitly permits third-party tooling. |
| [FSharp.Compiler.Service](https://github.com/dotnet/fsharp) | MIT | None. |
| [.NET Runtime](https://github.com/dotnet/runtime) | MIT + Patent Promise | Patent promise covers applications running on .NET Runtime. |
| [Fantomas](https://github.com/fsprojects/fantomas) | Apache-2.0 | None. |
| [ICSharpCode.Decompiler](https://github.com/icsharpcode/ILSpy) | MIT | None. |
| [Ionide.ProjInfo](https://github.com/ionide/proj-info) | MIT | None. |
| [tree-sitter](https://github.com/tree-sitter/tree-sitter) / grammars | MIT | None. |
| [salsa](https://github.com/salsa-rs/salsa) | Apache-2.0 / MIT | Dual-licensed. |
| Forge itself | MIT | Open source. No proprietary components. |

**Critical:** Forge must never incorporate code from C# Dev Kit's proprietary components (Solution Explorer, IntelliCode, test explorer). These are closed-source under Visual Studio licensing. All equivalent features must be reimplemented from publicly documented APIs and protocols.

## 9. Complete Feature TODO List

Every feature Forge must implement to achieve its stated mission of crushing Visual Studio, Rider, and C# Dev Kit. Features are grouped by category, prioritized (P0 = launch blocker, P1 = fast follow, P2 = competitive parity, P3 = superiority), and marked with their implementation status.

**Legend:** VS = Visual Studio, CDK = C# Dev Kit, R = Rider. ✓ = incumbent has this feature.

### 9.1 Code Intelligence

| Feature | VS | CDK | R | Priority | Phase |
|---|---|---|---|---|---|
| Auto-completion with full semantic context | ✓ | ✓ | ✓ | P0 | 2 |
| Completion with import suggestions | ✓ | ✓ | ✓ | P0 | 2 |
| AI-powered completion ranking | ✓ | ✓ | ✓ | P3 | 5 |
| Snippet completion | ✓ | ✓ | ✓ | P0 | 2 |
| Override member completion | ✓ | ✓ | ✓ | P1 | 3 |
| Postfix completion templates | ✗ | ✗ | ✓ | P2 | 4 |
| Hover / Quick Info | See [HOVER-SPEC.md](HOVER-SPEC.md) | | | P0 | 2 |
| Signature help / parameter info | ✓ | ✓ | ✓ | P0 | 2 |
| Inlay hints — type inference | ✓ | ✓ | ✓ | P1 | 3 |
| Inlay hints — parameter names | ✓ | ✓ | ✓ | P1 | 3 |
| Inlay hints — lambda return types | ✓ | ✗ | ✓ | P2 | 3 |
| Regex syntax highlighting in strings | ✓ | ✗ | ✓ | P2 | 4 |
| Date/time format string validation | ✗ | ✗ | ✓ | P3 | 5 |

### 9.2 Navigation

| Feature | VS | CDK | R | Priority | Phase |
|---|---|---|---|---|---|
| Go to definition | ✓ | ✓ | ✓ | P0 | 2 |
| Go to declaration | ✓ | ✓ | ✓ | P0 | 2 |
| Go to type definition | ✓ | ✓ | ✓ | P0 | 2 |
| Go to implementation | ✓ | ✓ | ✓ | P0 | 2 |
| Go to base member | ✓ | ✗ | ✓ | P1 | 3 |
| Find all references | ✓ | ✓ | ✓ | P0 | 2 |
| Find usages (advanced, grouped) | ✓ | ✗ | ✓ | P1 | 3 |
| Workspace symbol search | ✓ | ✓ | ✓ | P0 | 2 |
| Document symbol outline | ✓ | ✓ | ✓ | P0 | 1 |
| Call hierarchy (incoming) | ✓ | ✓ | ✓ | P1 | 3 |
| Call hierarchy (outgoing) | ✓ | ✓ | ✓ | P1 | 3 |
| Type hierarchy (supertypes) | ✓ | ✗ | ✓ | P1 | 3 |
| Type hierarchy (subtypes) | ✓ | ✗ | ✓ | P1 | 3 |
| Navigate to decompiled source | ✓ | ✓ | ✓ | P1 | 3 |
| Navigate to source generator output | ✓ | ✓ | ✗ | P2 | 4 |
| Navigate to metadata as source | ✓ | ✓ | ✓ | P1 | 3 |
| Go to related files | ✓ | ✗ | ✓ | P2 | 4 |
| Breadcrumb / scope bar | ✓ | ✓ | ✓ | P1 | 3 |
| Structural navigation (next/prev member) | ✓ | ✗ | ✓ | P2 | 4 |

### 9.3 Diagnostics & Analysis

See [DIAGNOSTICS-SPEC.md](DIAGNOSTICS-SPEC.md) § Competitive Analysis for the full feature comparison table. Key change from this document: **solution-wide analysis is now P0 (Phase 2), default enabled** — not P1/Phase 4.

### 9.4 Code Actions & Refactoring

| Feature | VS | CDK | R | Priority | Phase |
|---|---|---|---|---|---|
| All Roslyn built-in code fixes | ✓ | ✓ | ✓ | P0 | 3 |
| All Roslyn built-in refactorings | ✓ | ✓ | ✓ | P0 | 3 |
| Extract method | ✓ | ✓ | ✓ | P0 | 3 |
| Extract variable / constant / field | ✓ | ✓ | ✓ | P0 | 3 |
| Extract interface | ✓ | ✓ | ✓ | P1 | 3 |
| Extract superclass | ✓ | ✗ | ✓ | P2 | 4 |
| Inline variable / method / constant | ✓ | ✓ | ✓ | P1 | 3 |
| Rename symbol (all code elements and references) | ✓ | ✓ | ✓ | P0 | 2 |
| Rename file to match type | ✓ | ✓ | ✓ | P1 | 3 |
| Move type to file | ✓ | ✓ | ✓ | P1 | 3 |
| Move type to namespace | ✓ | ✗ | ✓ | P2 | 4 |
| Safe delete | ✓ | ✗ | ✓ | P2 | 4 |
| Change signature | ✓ | ✓ | ✓ | P2 | 4 |
| Introduce parameter | ✓ | ✓ | ✓ | P2 | 4 |
| Generate constructor | ✓ | ✓ | ✓ | P0 | 3 |
| Generate equals / GetHashCode | ✓ | ✓ | ✓ | P1 | 3 |
| Generate interface implementation | ✓ | ✓ | ✓ | P0 | 3 |
| Generate overrides | ✓ | ✓ | ✓ | P1 | 3 |
| Generate property from field | ✓ | ✓ | ✓ | P1 | 3 |
| Add using / open directive | ✓ | ✓ | ✓ | P0 | 3 |
| Organize usings / opens | ✓ | ✓ | ✓ | P0 | 3 |
| Convert between expression forms | ✓ | ✓ | ✓ | P1 | 3 |
| Surround with (try, if, using, etc.) | ✓ | ✗ | ✓ | P1 | 3 |
| Convert to LINQ / from LINQ | ✓ | ✓ | ✓ | P2 | 4 |
| Convert string concatenation ↔ interpolation | ✓ | ✓ | ✓ | P1 | 3 |
| Convert var ↔ explicit type | ✓ | ✓ | ✓ | P1 | 3 |
| Invert if | ✓ | ✓ | ✓ | P1 | 3 |
| Convert method group ↔ lambda | ✓ | ✓ | ✓ | P1 | 3 |
| Pull members up / push members down | ✓ | ✗ | ✓ | P2 | 4 |
| Convert class to record (C#) | ✓ | ✓ | ✓ | P2 | 4 |
| Convert anonymous type to class/record | ✓ | ✓ | ✓ | P2 | 4 |
| F#: Generate match cases from DU | ✗ | ✗ | ✗ | P1 | 3 |
| F#: Generate record field stubs | ✗ | ✗ | ✗ | P1 | 3 |
| F#: Convert pipe ↔ nested function calls | ✗ | ✗ | ✗ | P1 | 4 |
| F#: Convert to/from computation expression | ✗ | ✗ | ✗ | P2 | 4 |

### 9.5 Formatting & Style

Forge does **not** provide formatting. Use [CSharpier](https://csharpier.com/) for C# and [Fantomas](https://github.com/fsprojects/fantomas) (via [Ionide](https://ionide.io/)) for F#.

### 9.6 Semantic Highlighting & Visual Features

| Feature | VS | CDK | R | Priority | Phase |
|---|---|---|---|---|---|
| Full semantic tokens | ✓ | ✓ | ✓ | P0 | 2 |
| Delta semantic tokens | ✓ | ✓ | ✓ | P1 | 3 |
| Folding ranges (tree-sitter) | ✓ | ✓ | ✓ | P0 | 1 |
| Selection ranges (tree-sitter) | ✓ | ✓ | ✓ | P0 | 1 |
| Linked editing ranges | ✓ | ✓ | ✓ | P1 | 1 |
| Color information (CSS in Razor) | ✓ | ✗ | ✓ | P3 | 5 |

### 9.7 Debugging & Testing

> Full debugging feature parity details: [DEBUGGING-SPEC.md](./DEBUGGING-SPEC.md)

| Feature | VS | CDK | R | Priority | Phase |
|---|---|---|---|---|---|
| Launch/attach .NET process | ✓ | ✓ | ✓ | P1 | 4 |
| Breakpoints (line, conditional, logpoint) | ✓ | ✓ | ✓ | P1 | 4 |
| Step in/out/over | ✓ | ✓ | ✓ | P1 | 4 |
| Variable inspection | ✓ | ✓ | ✓ | P1 | 4 |
| Watch expressions | ✓ | ✓ | ✓ | P2 | 4 |
| Call stack navigation | ✓ | ✓ | ✓ | P1 | 4 |
| Async logical call stack | ✓ | ✓ | ✓ | P1 | 4 |
| Exception breakpoints | ✓ | ✓ | ✓ | P2 | 4 |
| Data breakpoints | ✓ | ✗ | ✓ | P2 | 5 |
| Return value display | ✓ | ✗ | ✓ | P2 | 5 |
| Hot reload (method body edits) | ✓ | ✓ | ✓ | P2 | 4 |
| Full expression eval (LINQ, lambdas) | ✓ | ✓ | ✓ | P1 | 5 |
| Remote debugging (SSH) | ✓ | ✓ | ✓ | P2 | 5 |
| Multi-process / compound launch | ✓ | ✗ | ✓ | P2 | 4 |
| Test discovery (xUnit/NUnit/MSTest) | ✓ | ✓ | ✓ | P1 | 4 |
| Test discovery (Expecto/FsCheck) | ✗ | ✗ | ✗ | P1 | 4 |
| Run/debug individual test | ✓ | ✓ | ✓ | P1 | 4 |
| Test result inline display | ✓ | ✓ | ✓ | P2 | 4 |
| Continuous testing | ✓ | ✗ | ✓ | P3 | 5 |
| Code coverage overlay | ✓ | ✗ | ✓ | P3 | 5 |

### 9.8 Workspace & Project Management

| Feature | VS | CDK | R | Priority | Phase |
|---|---|---|---|---|---|
| Solution/project loading | ✓ | ✓ | ✓ | P0 | 2 |
| SDK-style project support | ✓ | ✓ | ✓ | P0 | 2 |
| Legacy .csproj/.fsproj support | ✓ | ✓ | ✓ | P1 | 3 |
| Multi-targeting support | ✓ | ✓ | ✓ | P1 | 3 |
| Central Package Management | ✓ | ✓ | ✓ | P1 | 3 |
| Project dependency visualization | ✓ | ✗ | ✓ | P2 | 4 |
| NuGet package search & install | ✓ | ✗ | ✓ | P2 | 4 |
| NuGet package update suggestions | ✓ | ✗ | ✓ | P2 | 4 |
| Add/remove project reference | ✓ | ✓ | ✓ | P2 | 4 |
| File watching & auto-reload | ✓ | ✓ | ✓ | P0 | 2 |
| Configuration via forge.toml | ✗ | ✗ | ✗ | P0 | 1 |
| Global tool installation (dotnet tool) | ✗ | ✗ | ✗ | P0 | 1 |

### 9.9 F#-Specific Features

| Feature | VS | CDK | R | Priority | Phase |
|---|---|---|---|---|---|
| Pipeline type hints | ✓ | ✗ | ✓ | P1 | 3 |
| Signature file generation (.fsi) | ✓ | ✗ | ✓ | P1 | 4 |
| Union case generation | ✗ | ✗ | ✗ | P1 | 3 |
| Record stub generation | ✗ | ✗ | ✗ | P1 | 3 |
| Computation expression completions | ✓ | ✗ | ✓ | P1 | 3 |
| Type provider navigation | ✓ | ✗ | ✓ | P2 | 4 |
| F# Interactive (FSI) integration | ✓ | ✗ | ✓ | P2 | 4 |
| File ordering awareness & reorder | ✓ | ✗ | ✓ | P1 | 4 |
| Open statement management | ✓ | ✗ | ✓ | P0 | 3 |
| Fantomas integration | ✗ | ✗ | ✗ | P0 | 3 |
| FSharpLint integration | ✗ | ✗ | ✗ | P1 | 4 |
| FSharp.Analyzers.SDK support | ✗ | ✗ | ✗ | P1 | 4 |

### 9.10 Features That Will Make Forge SUPERIOR

These are features no single incumbent offers today. This is where Forge stops playing catch-up and starts setting the standard:

| Feature | VS | CDK | R | Priority | Phase |
|---|---|---|---|---|---|
| Unified C# + F# in one LSP server | ✗ | ✗ | ✓* | P0 | 2 |
| True editor-agnostic (10+ editors) | ✗ | ✗ | ✗ | P0 | 1 |
| Cross-language go-to-definition (C#↔F#) | ✗ | ✗ | ✓* | P2 | 4 |
| Cross-language find references (C#↔F#) | ✗ | ✗ | ✓* | P2 | 4 |
| Zero-config, zero-license instant setup | ✗ | ✗ | ✗ | P0 | 1 |
| Sub-millisecond syntax features (Rust+TS) | ✗ | ✗ | ✗ | P0 | 1 |
| Architecture analysis & visualization | ✗ | ✗ | ✓ | P3 | 5 |
| AI-assisted code actions via MCP | ✗ | ✗ | ✗ | P3 | 5 |
| Database-aware string analysis (SQL) | ✗ | ✗ | ✓ | P3 | 5 |
| Open governance & community-driven | ✗ | ✗ | ✗ | P0 | 1 |

*\* Rider supports both C# and F# but via proprietary code, not LSP, and not available to any other editor.*

## 10. Success Metrics

| Milestone | Criteria | Target Date |
|---|---|---|
| Alpha | Completions + diagnostics + go-to-definition working in VS Code for both C# and F# on a real-world solution | Month 8 |
| Beta | All P0 and P1 features working. Usable as a daily driver for C# and F# development | Month 14 |
| 1.0 Release | All P0, P1, P2 features. Performance targets met. 5+ editors verified | Month 20 |
| Community adoption | 1,000+ GitHub stars, 100+ daily active users | Month 24 |
| Feature superiority | Features no incumbent has (cross-language nav, AI actions, architecture analysis) | Month 24+ |

## 11. Distribution

Forge is distributed via three channels:

- **`forge-lsp`** — Homebrew (macOS/Linux) and Scoop (Windows), from GitHub release assets.
- **`Forge.Sidecar.CSharp`** — dotnet global tool on NuGet.org.
- **`Forge.Sidecar.FSharp`** — dotnet global tool on NuGet.org.

Editor extensions MUST verify all three binary versions on activation by
spawning each with `--version` and comparing against the extension's own
version. Extensions are forbidden from downloading binaries directly;
all installation goes through `brew`, `scoop`, or `dotnet tool`.

See [DISTRIBUTION-SPEC.md](DISTRIBUTION-SPEC.md) for the full distribution
specification including version invariants, release workflow, and the
editor extension contract.

---

**END OF SPECIFICATION**

*Forge: Because .NET developers deserve better.*
