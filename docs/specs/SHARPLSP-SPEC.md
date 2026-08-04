# [SHARPLSP-SPEC] SHARPLSP

**TECHNICAL SPECIFICATION v0.1**

## [SHARPLSP-MISSION] Mission

SharpLsp is an open-source, editor-agnostic [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) implementation for C# and F#, with a Rust host and compiler-backed .NET sidecars.

### [SHARPLSP-MISSION-PRINCIPLES] Design Principles

- **Editor-agnostic:** use LSP 3.17+ without editor-specific APIs.
- **Language parity:** C# and F# share infrastructure, feature targets, and test standards.
- **Open dependencies:** use Roslyn and FCS without proprietary Visual Studio or C# Dev Kit components.
- **Rust hot path:** keep protocol handling, document state, syntax parsing, routing, and memoization in Rust.
- **Compiler semantics:** delegate semantic analysis to Roslyn and FCS; do not reimplement type checkers.

## [SHARPLSP-ARCHITECTURE] Architecture

### [SHARPLSP-ARCHITECTURE-TIERS] High-Level Architecture

SharpLsp uses a Rust host for the LSP protocol and syntax analysis, plus managed .NET sidecars for C#/[Roslyn](https://github.com/dotnet/roslyn) and F#/[FCS](https://fsharp.github.io/fsharp-compiler-docs/) semantic analysis.

Primary implementations: [main.rs](../../src/sharplsp/src/main.rs), [handlers.rs](../../src/sharplsp/src/handlers.rs), [semantic.rs](../../src/sharplsp/src/semantic.rs), and the [sidecar protocol](../../src/sharplsp/src/sidecar/protocol.rs).

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
- [FSharpChecker](https://fsharp.github.io/fsharp-compiler-docs/reference/fsharp-compiler-codeanalysis-fsharpchecker.html) for parsing, checking, and semantic queries
- [Ionide.ProjInfo](https://github.com/ionide/proj-info) for project cracking (MSBuild evaluation for F# projects)
- [FSharpLint](https://github.com/fsprojects/FSharpLint) for linting
- Same RPC interface and transport as the C# sidecar

### [SHARPLSP-ARCHITECTURE-CACHING] Cache Ownership

Rust-host salsa MUST be the only memoization mechanism. Sidecars and clients MAY retain authoritative compiler, document, protocol, and rendered UI state, but MUST NOT cache feature results. LRU, dictionary/map-backed, sidecar-local, client-local, and other ad-hoc result caches are forbidden.

### [SHARPLSP-ARCHITECTURE-IPC] IPC Transport Protocol

Communication between the Rust host and .NET sidecars uses a custom binary RPC protocol:

| Property | Specification |
|---|---|
| Transport | Named pipes (Windows) / Unix domain sockets (Linux, macOS) |
| Serialization | [MessagePack](https://msgpack.org/) via [rmp-serde](https://crates.io/crates/rmp-serde) (Rust) and [MessagePack-CSharp](https://github.com/MessagePack-CSharp/MessagePack-CSharp) (.NET) |
| Framing | 4-byte little-endian length prefix + MessagePack payload |
| Concurrency | One active host-to-sidecar request per connection; request IDs provide exact correlation, while a single connection driver dispatches interleaved server-initiated notifications |
| Cancellation | Dedicated cancel notification matching LSP `$/cancelRequest` semantics |
| Performance target | <500µs round-trip overhead (excluding compiler work) |

The detailed frame ownership, correlation, notification, health, and poisoning rules are normative in [SIDECAR-LIFECYCLE-SPEC.md](SIDECAR-LIFECYCLE-SPEC.md).

### [SHARPLSP-ARCHITECTURE-ROUTING] Request Routing Strategy

The Rust host classifies every incoming LSP request and routes it to the fastest handler:

| Category | Handler | Latency Target | Examples |
|---|---|---|---|
| Syntax-only | Rust (tree-sitter) | <5ms | documentSymbol, foldingRange, selectionRange, linkedEditingRange |
| Semantic | Sidecar (Roslyn/FCS) | <200ms | completion, hover, definition, references, rename, codeAction, diagnostics |
| Hybrid | Rust + Sidecar | <100ms | semanticTokens (tree-sitter for structure, sidecar for classification) |
| Memoized | Rust-host salsa | <1ms | Repeat requests for unchanged inputs |

Key optimization: on every keystroke, tree-sitter re-parses in <1ms and provides immediate feedback for syntax-level features, while semantic requests are coalesced with a debounce window (default 150ms) before dispatching to sidecars. Stale in-flight semantic requests are cancelled when superseded.

### [SHARPLSP-ARCHITECTURE-SIDECARS] Sidecar Lifecycle Management

The normative state machine and platform contract are in [SIDECAR-LIFECYCLE-SPEC.md](SIDECAR-LIFECYCLE-SPEC.md).

- **Startup:** A per-language supervisor lazily launches one direct, version-matched sidecar process, using a new current-user-only IPC endpoint for every generation. `READY` identifies the generation, process, protocol, and effective bound endpoint; semantic readiness follows workspace bootstrap.
- **Health monitoring:** The connection driver pings only while `Ready` and idle (every 5s, with a 2s response budget). An in-flight request is governed by its own deadline and cannot race a second transport-locking health caller.

#### [SHARPLSP-ARCHITECTURE-SIDECARS-TIMEOUT] Request Timeouts

Every host-to-sidecar request carries a response budget: 600s for `workspace/open` and 120s for everything else. A request that exceeds its budget fails, poisons the IPC connection, and terminates the contained sidecar process tree, so a late response cannot reach the next caller.

- **Crash recovery:** Startup and runtime failures share one exponential backoff sequence (1s, 2s, 4s, up to 30s). A replacement generation replays workspace, configuration, and current VFS document state before becoming ready. Only Rust-host salsa query results MAY provide explicitly stale graceful degradation.
- **Isolation and containment:** C# and F# supervisors, backoff, endpoints, and process trees are independent. Windows Job Objects and Unix process groups/parent-death handling prevent orphaned sidecars and compiler descendants.
- **Shutdown:** The sidecar flushes a correlated shutdown acknowledgement before cancelling its loop. The host allows up to 5s for clean exit, then terminates and reaps only that generation's contained process tree.

### [SHARPLSP-ARCHITECTURE-PROJECTS] Project System

Project evaluation MUST handle SDK-style and legacy `.csproj`/`.fsproj` files, multi-targeting, [Directory.Build.props](https://learn.microsoft.com/en-us/visualstudio/msbuild/customize-by-directory), [Directory.Packages.props](https://learn.microsoft.com/en-us/nuget/consume-packages/central-package-management), [global.json](https://learn.microsoft.com/en-us/dotnet/core/tools/global-json), conditional symbols, and NuGet resolution.

- **C# projects:** [MSBuildWorkspace](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.msbuild.msbuildworkspace) ([Microsoft.CodeAnalysis.Workspaces.MSBuild](https://www.nuget.org/packages/Microsoft.CodeAnalysis.Workspaces.MSBuild) + [Microsoft.Build.Locator](https://github.com/microsoft/MSBuildLocator)) performs design-time builds to extract source files, references, and compiler options.
- **F# projects:** [Ionide.ProjInfo](https://github.com/ionide/proj-info) performs MSBuild evaluation with F#-specific handling (file ordering, which is semantically significant in F#).
- **Mixed solutions:** Both sidecars load their respective projects from the same `.sln` or `.slnx` solution file. Cross-language project references are resolved via binary reference (compiled DLL), not source-level.
- **Solution files:** SharpLsp treats legacy `.sln` and XML `.slnx` as first-class solution inputs. Shared sidecar code reads both formats through `Microsoft.VisualStudio.SolutionPersistence` and exposes a neutral `solution/read` DTO so host/editor code does not parse solution text.
- **File watching:** The Rust host watches .csproj, .fsproj, .sln, .slnx, Directory.Build.props, Directory.Packages.props, NuGet.config, and global.json for changes. On change, the affected sidecar is notified to reload the project model.
- **Multi-targeting:** Projects targeting multiple TFMs (e.g., `net8.0;net48;netstandard2.0`) present multiple analysis contexts. SharpLsp exposes a custom LSP extension for users to select the active TFM, defaulting to the first.
- **Project-less files:** A `.cs` [file-based app](https://learn.microsoft.com/en-us/dotnet/core/sdk/file-based-apps), a `.csx` Roslyn script, and a `.fsx` F# script are all first-class editing targets with no owning project. Their compilation closure is derived from the root file — `#:include` for file-based apps, `#load` for scripts — and never from the containing directory. See [SCRIPTING-FILEBASED-SPEC.md](SCRIPTING-FILEBASED-SPEC.md).

#### [SHARPLSP-ARCHITECTURE-PROJECTS-SOLUTION-PATH] Choosing the Solution to Open

The host sends one path to each sidecar's `workspace/open`. When that path is a directory, the C# sidecar discovers a target under it: an unambiguous `.sln`, `.slnx`, or `.csproj` is opened directly. Discovery **never guesses** between several nested solutions — a monorepo root holding `app/App.sln` and `other/Other.sln` is ambiguous, and guessing would silently load the wrong half of the repository.

`csharp.solution_path` in `sharplsp.toml` resolves that ambiguity by naming the solution to open, absolute or relative to the workspace root:

```toml
[csharp]
solution_path = "app/App.sln"
```

The host resolves the setting and sends the **solution file** rather than the root, so the sidecar opens it without running discovery at all. The setting falls back to workspace-root discovery when unset, and when it names a path that is not an existing file — a stale or misspelled entry degrades to auto-discovery instead of wedging the workspace on a path that cannot load.

### [SHARPLSP-ARCHITECTURE-BINARIES] Binary Layout and Installation

Every per-platform VSIX MUST bundle `sharplsp`.

**Per-platform VSIX layout:**

The binary lives at:

```
bin/<platform>/sharplsp        (Unix)
bin/<platform>/sharplsp.exe    (Windows)
```

| Platform | Binary path inside VSIX |
|----------|------------------------|
| `darwin-arm64` | `bin/darwin-arm64/sharplsp` |
| `darwin-x64` | `bin/darwin-x64/sharplsp` |
| `linux-x64` | `bin/linux-x64/sharplsp` |
| `linux-arm64` | `bin/linux-arm64/sharplsp` |
| `win32-x64` | `bin/win32-x64/sharplsp.exe` |
| `win32-arm64` | `bin/win32-arm64/sharplsp.exe` |

**Shipwright resolution order for `sharplsp`:**

1. `sharplsp.lspPath` user setting — absolute path override
2. `SHARPLSP_LSP_PATH` env var — CI and dev overrides
3. `SHARPLSP_BINARY_DIR` env var — directory override
4. **Bundled** (`bin/<platform>/sharplsp[.exe]` inside `extensionPath`) ← **default for all users**
5. PATH — system-installed `sharplsp`
6. Package manager — Homebrew (macOS/Linux), Scoop (Windows)

**Sidecar install locations:**

Sidecars are framework-dependent .NET 10 executables bundled under `bin/all/`; a missing runtime or sidecar is an activation failure.

| Artifact | VSIX path | Resolver sources |
|---|---|---|
| C# sidecar | `bin/all/sharplsp-sidecar-csharp` | user setting, environment variable, bundled, PATH |
| F# sidecar | `bin/all/sharplsp-sidecar-fsharp` | user setting, environment variable, bundled, PATH |

**Version checking (`--version` flag):**

All three binaries support `--version` and print their version to stdout:

```
$ sharplsp --version
sharplsp 0.1.0

$ sharplsp-sidecar-csharp --version
sharplsp-sidecar-csharp 0.1.0

$ sharplsp-sidecar-fsharp --version
sharplsp-sidecar-fsharp 0.1.0
```

Extensions use this output to verify all versions before starting.

### [SHARPLSP-ARCHITECTURE-EXTENSIONS] Editor Extension Binary Strategy

Binary resolution is handled exclusively by `@nimblesite/shipwright-vscode` (`activateDeploymentToolkit`). Extensions MUST NOT hand-roll binary resolution.

On activation, the VS Code extension follows this sequence:

1. **Shipwright resolves `sharplsp`:** Checks user setting → env vars → bundled binary → PATH → pkgmgr. The bundled binary is the default path — it always exists in a valid VSIX install.
2. **Shipwright resolves sidecars:** Checks user setting → env vars → bundled `bin/all/` sidecar → PATH. Bundled sidecars are the default for VSIX installs.
3. **Version verification:** Shipwright probes each resolved binary with `--version` and compares against the manifest's `expectedVersion`.
4. **Start LSP client:** Pass the resolved `sharplsp` path to `LanguageClient`. Never hardcode a path.

#### [SHARPLSP-ARCHITECTURE-EXTENSIONS-SIDECAR-ENV] Sidecar Environment Overrides

`SHARPLSP_CSHARP_SIDECAR_PATH` and `SHARPLSP_FSHARP_SIDECAR_PATH` take precedence when they name an existing path. A missing override path MUST emit a warning and continue with PATH, installed-layout, and development-build resolution.

**Missing required components fail activation:**

When any required component step above fails — version mismatch, binary not found, missing .NET 10, or `--version` returns garbage — the extension MUST:

- Show a clear, user-facing error message explaining what happened and how to fix it (e.g., "SharpLsp: sharplsp v0.1.0 required but v0.0.9 found.")
- Fail activation instead of starting without C# or F# support
- MUST NOT block the editor's main thread or event loop
- MUST release resources after partial initialization

These requirements apply to every editor extension.

**Version contract:**

| Component | Version source | `--version` output format |
|---|---|---|
| `sharplsp` | `Cargo.toml` via `env!("CARGO_PKG_VERSION")` | `sharplsp X.Y.Z` |
| C# sidecar | `.csproj` AssemblyVersion | `sharplsp-sidecar-csharp X.Y.Z` |
| F# sidecar | `.fsproj` AssemblyVersion | `sharplsp-sidecar-fsharp X.Y.Z` |
| VS Code ext | `package.json` version field | N/A (not a CLI) |
| Zed ext | `extension.toml` version field | N/A (not a CLI) |

All versions MUST be kept in sync across all components. A release tags all components at the same version. Extensions MUST check the binary version matches their own version before starting the server.

**Test requirements:**

Every editor extension MUST have e2e tests that prove:
1. `sharplsp --version` returns the correct format and version
2. When the version matches, the extension starts the server successfully
3. When the version mismatches, the extension shows a user-facing error and does NOT freeze the editor
4. When the binary is missing, the extension shows a user-facing error and does NOT freeze the editor

The Rust binary MUST have a test that proves:
1. `--version` prints the correct format: `sharplsp X.Y.Z` where X.Y.Z matches `Cargo.toml`
2. The process exits with code 0

## [SHARPLSP-TECHNOLOGY] Technology Stack

### [SHARPLSP-TECHNOLOGY-RUST] Rust Host Crates

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
| [dashmap](https://crates.io/crates/dashmap) | 6.x | Concurrent runtime state; MUST NOT store memoized feature results |

### [SHARPLSP-TECHNOLOGY-CSHARP] C# Sidecar Packages

| Package | Version | Purpose |
|---|---|---|
| [Microsoft.CodeAnalysis](https://www.nuget.org/packages/Microsoft.CodeAnalysis) | 5.3.0 | Roslyn compiler platform (syntax, semantic model, diagnostics) |
| [Microsoft.CodeAnalysis.CSharp.Workspaces](https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp.Workspaces) | 5.3.0 | C# workspace services |
| [Microsoft.CodeAnalysis.CSharp.Features](https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp.Features) | 5.3.0 | IDE features: completions, code fixes, refactorings |
| [Microsoft.CodeAnalysis.Workspaces.MSBuild](https://www.nuget.org/packages/Microsoft.CodeAnalysis.Workspaces.MSBuild) | 5.0.0 | MSBuild project/solution loading |
| [Microsoft.Build.Locator](https://github.com/microsoft/MSBuildLocator) | latest | MSBuild installation discovery |
| [ICSharpCode.Decompiler](https://github.com/icsharpcode/ILSpy/tree/master/ICSharpCode.Decompiler) | latest | Decompiled metadata source navigation |
| [MessagePack-CSharp](https://github.com/MessagePack-CSharp/MessagePack-CSharp) | latest | IPC serialization |

### [SHARPLSP-TECHNOLOGY-FSHARP] F# Sidecar Packages

| Package | Version | Purpose |
|---|---|---|
| [FSharp.Compiler.Service](https://www.nuget.org/packages/FSharp.Compiler.Service) | 43.12.201 | F# compiler services (parsing, type checking, IDE features) |
| [Ionide.ProjInfo](https://github.com/ionide/proj-info) | latest | F# project cracking (MSBuild evaluation) |
| [FSharpLint.Core](https://github.com/fsprojects/FSharpLint) | latest | F# linting diagnostics |
| [FSharp.Analyzers.SDK](https://github.com/ionide/FSharp.Analyzers.SDK) | latest | Third-party F# analyzer support |
| [MessagePack-CSharp](https://github.com/MessagePack-CSharp/MessagePack-CSharp) | latest | IPC serialization |

## [SHARPLSP-FEATURES] Feature Specification

Both C# and F# columns require full support unless noted.

### [SHARPLSP-FEATURES-INTELLIGENCE] Code Intelligence

| Feature | LSP Method | C# API (Roslyn) | F# API (FCS) | Priority |
|---|---|---|---|---|
| Auto-completion | `textDocument/completion` | [CompletionService.GetCompletionsAsync()](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.completion.completionservice.getcompletionsasync) | GetDeclarationListInfo() | P0 |
| Completion resolve | `completionItem/resolve` | [CompletionService.GetDescriptionAsync()](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.completion.completionservice.getdescriptionasync) | GetDeclarationListInfo (detail) | P0 |
| Completion edit semantics | `textDocument/completion` | `GetDefaultCompletionListSpan` + trailing-ident extension → `textEdit` — `[SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT]` | `QuickParse.GetPartialLongNameEx` island + trailing-ident extension → `textEdit` — `[SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT]` | P0 |
| Hover / Quick Info | `textDocument/hover` | See [HOVER-SPEC.md](HOVER-SPEC.md) | See [HOVER-SPEC.md](HOVER-SPEC.md) | P0 |
| Signature help | `textDocument/signatureHelp` | SignatureHelpService.GetItemsAsync() | GetMethods() | P0 |
| Parameter hints | `textDocument/signatureHelp` | Same (active parameter tracking) | Same (active parameter tracking) | P0 |
| Inlay hints (types) | `textDocument/inlayHint` | Type inference display | Type inference display | P1 |
| Inlay hints (params) | `textDocument/inlayHint` | Parameter name hints | Parameter name hints | P1 |
| Inline values | `textDocument/inlineValue` | Debugger expression eval | Debugger expression eval | P2 |

#### [SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-EDIT] Completion Edit Semantics

Every completion item returned by either sidecar carries an explicit LSP `textEdit`, not just an `insertText`. Its range is the identifier span **at the caret** — the typed prefix to the left of the cursor *plus any identifier characters that already follow it on the same line*. Accepting an item therefore **replaces** that identifier instead of being appended to it: completing `WriteLine` at `Console.|WriteLine` yields `Console.WriteLine`, never `Console.WriteLineWriteLine` (GitHub #178). Without a `textEdit` the editor falls back to its own word-boundary heuristic, which appends after a member-access trigger character and duplicates the identifier.

The C# sidecar derives the span from [`CompletionService.GetDefaultCompletionListSpan`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.completion.completionservice.getdefaultcompletionlistspan) extended over trailing identifier characters; the F# sidecar derives it from the FCS partial-name island (`QuickParse.GetPartialLongNameEx`) with the same trailing-character extension. The `NewText` is the item's insert text. The Rust host maps the flat sidecar edit onto `CompletionItem.textEdit` in `src/sharplsp/src/semantic.rs`.

### [SHARPLSP-FEATURES-NAVIGATION] Navigation

| Feature | LSP Method | C# API (Roslyn) | F# API (FCS) | Priority |
|---|---|---|---|---|
| Go to definition | See [DEFINITION-SPEC.md](DEFINITION-SPEC.md) | | | P0 |
| Go to declaration | See [DEFINITION-SPEC.md](DEFINITION-SPEC.md) | | | P0 |
| Go to type definition | See [DEFINITION-SPEC.md](DEFINITION-SPEC.md) | | | P0 |
| Go to implementation | See [DEFINITION-SPEC.md](DEFINITION-SPEC.md) | | | P0 |
| Find all references | `textDocument/references` | [SymbolFinder.FindReferencesAsync()](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.findusages.symbolfinder.findreferencesasync) | GetUsesOfSymbolInFile/Project() | P0 |
| Document highlights | `textDocument/documentHighlight` | SymbolFinder (scoped to doc) | GetUsesOfSymbolInFile() | P0 |
| Workspace symbol search | `workspace/symbol` | tree-sitter over open docs (host) | FCS document symbols via sidecar (host has no F# tree-sitter grammar) | P0 |
| Document symbols | `textDocument/documentSymbol` | tree-sitter structural extraction | tree-sitter structural extraction | P0 |
| Call hierarchy prepare | `textDocument/prepareCallHierarchy` | Symbol resolution | FCS symbol resolution | P1 |
| Incoming calls | `callHierarchy/incomingCalls` | SymbolFinder.FindCallersAsync() | Project-wide FCS symbol uses | P1 |
| Outgoing calls | `callHierarchy/outgoingCalls` | Semantic model invocation walk | FCS parse/check traversal | P1 |
| Type hierarchy prepare | `textDocument/prepareTypeHierarchy` | Symbol resolution | FCS entity resolution | P1 |
| Supertypes | `typeHierarchy/supertypes` | Base type and interface symbols | `BaseType` + `DeclaredInterfaces` | P1 |
| Subtypes | `typeHierarchy/subtypes` | FindDerivedClasses | Project entity scan | P1 |
| Breadcrumbs | `textDocument/documentSymbol` | Hierarchical symbol tree | Hierarchical symbol tree | P1 |
| Go to decompiled source | Custom: `sharplsp/decompileSource` | [ICSharpCode.Decompiler](https://github.com/icsharpcode/ILSpy) | ICSharpCode.Decompiler | P1 |
| Go to source generator output | Custom: `sharplsp/generatorOutput` | GeneratorDriverRunResult | N/A | P2 |

### [SHARPLSP-FEATURES-DIAGNOSTICS] Diagnostics and Analysis

SharpLsp uses the LSP 3.17 **pull-diagnostics + workspace-refresh** model (`textDocument/diagnostic`, `workspace/diagnostic`, `workspace/diagnostic/refresh`), mirroring `Microsoft.CodeAnalysis.LanguageServer` (the engine behind C# Dev Kit). The Rust host never proactively pushes errors during workspace load — that is the only architecture that produces correct diagnostics while NuGet restore, source generators, and cross-project `CompilationReference`s are still resolving. A NuGet restore gate runs before `MSBuildWorkspace.OpenSolutionAsync` to eliminate the largest class of phantom CS0246s.

See [DIAGNOSTICS-SPEC.md](DIAGNOSTICS-SPEC.md) for the full specification, including the pull + refresh cycle, the NuGet restore gate, project filtering, and the truth guarantees SharpLsp makes (and doesn't make) about diagnostic completeness during workspace load.

SharpLsp also owns custom static analyzers that run through the same workspace diagnostics channel. The first rules detect unused public C# and F# code elements at solution scope, but only when `sharplsp.toml` explicitly marks the workspace as a monorepo. See [DIAGNOSTICS-STATIC-ANALYZERS-SPEC.md](DIAGNOSTICS-STATIC-ANALYZERS-SPEC.md).

### [SHARPLSP-FEATURES-REFACTORING] Code Actions and Refactoring

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

### [SHARPLSP-FEATURES-FORMATTING] Formatting

SharpLsp does **not** provide document formatting. Use dedicated formatters:

- **C#**: [CSharpier](https://csharpier.com/) — the community-standard opinionated C# formatter
- **F#**: [Fantomas](https://github.com/fsprojects/fantomas) via the [Ionide](https://ionide.io/) extension — the standard F# formatter

### [SHARPLSP-FEATURES-HIGHLIGHTING] Semantic Highlighting

| Feature | LSP Method | C# API | F# API | Priority |
|---|---|---|---|---|
| Full semantic tokens | `textDocument/semanticTokens/full` | [Classifier.GetClassifiedSpans()](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.classification.classifier.getclassifiedspans) | GetSemanticClassification() | P0 |
| Delta semantic tokens | `textDocument/semanticTokens/full/delta` | Incremental classification | Incremental classification | P1 |
| Range semantic tokens | `textDocument/semanticTokens/range` | Classifier (range-scoped) | GetSemanticClassification (range) | P0 |

### [SHARPLSP-FEATURES-CODE-LENS] Code Lens

| Feature | LSP Method | C# API | F# API | Priority |
|---|---|---|---|---|
| Reference count | `textDocument/codeLens` | SymbolFinder.FindReferences() | GetUsesOfSymbol() | P1 |
| Implementation count | `textDocument/codeLens` | SymbolFinder.FindImplementations() | Custom implementation count | P1 |
| Test indicators | `textDocument/codeLens` | Test framework attribute detection | Test framework attribute detection | P1 |
| Run/debug test | `textDocument/codeLens` | Custom test runner integration | Custom test runner integration | P2 |
| Recent changes (git) | `textDocument/codeLens` | git log integration | git log integration | P3 |

### [SHARPLSP-FEATURES-DEBUGGING] Debugging

See [DEBUGGING-SPEC.md](DEBUGGING-SPEC.md) for the DAP router and debug-sidecar contract.

### [SHARPLSP-FEATURES-TESTING] Test Discovery and Execution

| Feature | Protocol | Implementation | Priority |
|---|---|---|---|
| Discover tests ([xUnit](https://xunit.net/), [NUnit](https://nunit.org/), [MSTest](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-intro)) | Custom: `sharplsp/testDiscovery` | Test adapter protocol / [vstest](https://github.com/microsoft/vstest) | P1 |
| Run individual test | Custom: `sharplsp/testRun` | `dotnet test --filter` | P1 |
| Run test class/namespace | Custom: `sharplsp/testRun` | `dotnet test --filter` (scoped) | P1 |
| Debug individual test | DAP + `sharplsp/testDebug` | Launch with debugger attached | P2 |
| Test results inline | `textDocument/codeLens` | Pass/fail indicators on test methods | P2 |
| Continuous testing | Custom: `sharplsp/testWatch` | File watcher + selective re-run | P3 |
| Code coverage | Custom: `sharplsp/coverage` | [coverlet](https://github.com/coverlet-coverage/coverlet) integration | P3 |
| F# [Expecto](https://github.com/haf/expecto)/[FsCheck](https://github.com/fscheck/FsCheck) support | Custom: `sharplsp/testDiscovery` | Expecto test tree discovery | P1 |

### [SHARPLSP-FEATURES-WORKSPACE] Workspace Features

| Feature | LSP Method | Implementation | Priority |
|---|---|---|---|
| Solution/project loading | Custom: `sharplsp/openSolution` | MSBuildWorkspace + Ionide.ProjInfo | P0 |
| Project dependency graph | Custom: `sharplsp/projectGraph` | MSBuild project reference analysis | P1 |
| NuGet package search | Custom: `sharplsp/nuget/search` | HTTP GET nuget.org v3 API, cross-ref installed | P2 |
| NuGet package versions | Custom: `sharplsp/nuget/versions` | HTTP GET nuget.org flat container API | P2 |
| NuGet installed packages | Custom: `sharplsp/nuget/installed` | `dotnet list <project> package --format json` | P2 |
| NuGet install package | Custom: `sharplsp/nuget/install` | `dotnet add <project> package` + sidecar reload | P2 |
| NuGet uninstall package | Custom: `sharplsp/nuget/uninstall` | `dotnet remove <project> package` + sidecar reload | P2 |
| Multi-TFM selection | Custom: `sharplsp/targetFramework` | Active TFM switching per project | P1 |
| File watching & reload | `workspace/didChangeWatchedFiles` | [notify](https://crates.io/crates/notify) crate + sidecar reload | P0 |
| Workspace diagnostics (pull) | `workspace/diagnostic` + `workspace/diagnostic/refresh` | Solution-wide error analysis via LSP 3.17 pull model + 2000ms-debounced refresh; primary diagnostic path (see [DIAG-ARCHITECTURE-PULL-REFRESH](DIAGNOSTICS-SPEC.md)) | P0 |
| Monorepo static analyzers | `workspace/diagnostic` partial results | SharpLsp-owned unused-public-code analyzers for C# and F#; gated by `workspace.repository_kind = "monorepo"` | P0 |
| NuGet restore gate | (internal, before `workspace/open`) | `dotnet restore` if `obj/project.assets.json` is stale; eliminates phantom CS0246 for NuGet types ([DIAG-RESTORE](DIAGNOSTICS-SPEC.md)) | P0 |
| Project init complete | Custom: `workspace/projectInitializationComplete` | Notification fired once per workspace open after restore + `MSBuildWorkspace.OpenSolutionAsync`; matches Roslyn LSP contract | P0 |
| Configuration | `workspace/didChangeConfiguration` | [.editorconfig](https://editorconfig.org/) + sharplsp.toml | P0 |

### [SHARPLSP-FEATURES-FSHARP] F#-Specific Features

| Feature | LSP Method | Implementation | Priority |
|---|---|---|---|
| Pipeline hints | `textDocument/inlayHint` | FSAC pipelineHint | P1 |
| Signature file generation | Custom: `sharplsp/fsharpSignature` | FCS signature generation | P1 |
| Union case generation | `textDocument/codeAction` | Generate match cases from DU | P1 |
| Record stub generation | `textDocument/codeAction` | Generate record field stubs | P1 |
| Open statement management | `textDocument/codeAction` | Auto-open + organize opens | P0 |
| Computation expression support | `textDocument/completion` | CE-aware completions | P1 |
| Type provider navigation | `textDocument/definition` | Type provider generated type nav | P2 |
| F# Interactive integration | Custom: `sharplsp/fsi` | Send selection to FSI, evaluate | P2 |
| File ordering awareness | Custom: `sharplsp/fileOrder` | Semantic file reorder suggestions | P1 |

## [SHARPLSP-PERFORMANCE] Performance Requirements

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

## [SHARPLSP-PLAN] Implementation Plan

### [SHARPLSP-PLAN-PROTOCOL] Protocol Skeleton and Syntax Features

**Schedule:** Months 1–3.

- Rust binary implementing [LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/) lifecycle (initialize, initialized, shutdown, exit)
- Full document synchronization (open, change, close, save) with VFS
- [tree-sitter](https://tree-sitter.github.io/tree-sitter/) integration for C# (v0.23.1) and F# ([ionide grammar](https://github.com/ionide/tree-sitter-fsharp))
- Document symbols, folding ranges, selection ranges, linked editing ranges from tree-sitter
- Basic syntax highlighting via tree-sitter queries
- VS Code extension that spawns the Rust binary via stdio
- CI/CD pipeline with cross-platform builds (Linux, macOS, Windows)
- Logging infrastructure via [tracing](https://crates.io/crates/tracing) crate with [OpenTelemetry](https://opentelemetry.io/) export

### [SHARPLSP-PLAN-SEMANTICS] Sidecar Integration and Core Semantics

**Schedule:** Months 4–8.

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

### [SHARPLSP-PLAN-REFACTORING] Code Actions and Refactoring

**Schedule:** Months 9–14.

- All Roslyn built-in CodeFixProviders exposed via LSP code actions
- All Roslyn built-in CodeRefactoringProviders exposed via LSP code actions
- [FSAC](https://github.com/fsharp/FsAutoComplete) code fixes and refactorings for F#
- Extract method, extract variable, inline, move type, rename file
- Generate constructor, equals/hashcode, interface implementation, overrides
- Inlay hints (type inference, parameter names) for both languages
- Call hierarchy and type hierarchy
- Code lens (reference count, implementation count)
- Decompiled source navigation via [ICSharpCode.Decompiler](https://github.com/icsharpcode/ILSpy)

### [SHARPLSP-PLAN-ECOSYSTEM] Advanced Features and Ecosystem

**Schedule:** Months 15–20.

- Solution-wide error analysis (SWEA equivalent)
- Test discovery and execution ([xUnit](https://xunit.net/), [NUnit](https://nunit.org/), [MSTest](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-mstest-intro), [Expecto](https://github.com/haf/expecto), [FsCheck](https://github.com/fscheck/FsCheck))
- [DAP](https://microsoft.github.io/debug-adapter-protocol/specification) integration for debugging — see [DEBUGGING-SPEC.md](./DEBUGGING-SPEC.md) (Phase 4: netcoredbg + DapRouter; Phase 5: SharpLsp Debug Sidecar with full vsdbg parity)
- Workspace management (solution opening, project graph, NuGet management)
- F#-specific features: signature files, pipeline hints, FSI integration, file ordering
- Source generator output viewing
- Third-party analyzer support (NuGet analyzers for C#, [FSharp.Analyzers.SDK](https://github.com/ionide/FSharp.Analyzers.SDK) for F#)
- Monorepo-only unused public C# and F# code element analyzers
- Multi-editor verification (Neovim, Helix, Zed, Emacs, Sublime)
- Hot reload support via [dotnet watch](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-watch)
- Performance optimization pass (memory budgets, salsa query/input lifecycle, lazy loading)
- Custom Rider-class inspections beyond Roslyn's built-in set

### [SHARPLSP-PLAN-LEADERSHIP] Beyond Parity

**Schedule:** Month 21 onward.

- AI-assisted code actions (LLM-powered refactoring suggestions via [MCP](https://modelcontextprotocol.io/) or custom protocol)
- Cross-language navigation (C# ↔ F# within the same solution, via binary references initially, source-level eventually)
- Architecture analysis (dependency visualization, cyclic dependency detection, layer violation warnings)
- Performance profiling integration ([dotnet-trace](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-trace), [dotnet-counters](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-counters))
- Memory analysis integration ([dotnet-dump](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-dump))
- Database-aware analysis (SQL-in-string validation, [EF Core](https://learn.microsoft.com/en-us/ef/core/) migration awareness)
- Collaborative editing support (operational transform / CRDT)

## [SHARPLSP-RISKS] Risks and Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| Roslyn Features APIs are internal | High | High | Use reflection for internal APIs. Contribute upstream PRs to make critical APIs public. Monitor Roslyn releases for API surface changes. |
| MSBuild evaluation complexity | High | Certain | Leverage MSBuildWorkspace (proven by [OmniSharp](https://github.com/OmniSharp/omnisharp-roslyn)). Build comprehensive test suite against real-world `.sln` and `.slnx` files. Handle failure gracefully with partial project loading. |
| Memory pressure in large solutions | High | Medium | Implement per-project sidecar pooling. Enforce memory budgets through salsa query/input lifecycle. Consider separate sidecar instances per project in extreme cases. |
| F# tree-sitter grammar incomplete | Medium | Medium | Fall back to FCS for any syntax feature where tree-sitter produces incorrect results. Contribute upstream to improve the grammar. |
| Roslyn version coupling | Medium | Certain | Pin Roslyn version per SharpLsp release. Test against multiple Roslyn versions in CI. Abstract sidecar RPC to isolate version dependencies. |

## [SHARPLSP-LICENSING] Licensing

SharpLsp is MIT-licensed. All dependencies are compatible:

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
| SharpLsp itself | MIT | Open source. No proprietary components. |

**Critical:** SharpLsp must never incorporate code from C# Dev Kit's proprietary components (Solution Explorer, IntelliCode, test explorer). These are closed-source under Visual Studio licensing. All equivalent features must be reimplemented from publicly documented APIs and protocols.

## [SHARPLSP-TODO] Complete Feature List

Priorities: P0 = launch blocker, P1 = fast follow, P2 = parity, P3 = later.

### [SHARPLSP-TODO-INTELLIGENCE] Code Intelligence

| Feature | Priority | Phase |
| --- | --- | --- |
| Auto-completion with full semantic context | P0 | 2 |
| Completion with import suggestions | P0 | 2 |
| AI-powered completion ranking | P3 | 5 |
| Snippet completion | P0 | 2 |
| Override member completion | P1 | 3 |
| Postfix completion templates | P2 | 4 |
| Hover / Quick Info (see [HOVER-SPEC.md](HOVER-SPEC.md)) | P0 | 2 |
| Signature help / parameter info | P0 | 2 |
| Inlay hints — type inference | P1 | 3 |
| Inlay hints — parameter names | P1 | 3 |
| Inlay hints — lambda return types | P2 | 3 |
| Regex syntax highlighting in strings | P2 | 4 |
| Date/time format string validation | P3 | 5 |

### [SHARPLSP-TODO-NAVIGATION] Navigation

| Feature | Priority | Phase |
| --- | --- | --- |
| Go to definition | P0 | 2 |
| Go to declaration | P0 | 2 |
| Go to type definition | P0 | 2 |
| Go to implementation | P0 | 2 |
| Go to base member | P1 | 3 |
| Find all references | P0 | 2 |
| Find usages (advanced, grouped) | P1 | 3 |
| Workspace symbol search | P0 | 2 |
| Document symbol outline | P0 | 1 |
| Call hierarchy (incoming) | P1 | 3 |
| Call hierarchy (outgoing) | P1 | 3 |
| Type hierarchy (supertypes) | P1 | 3 |
| Type hierarchy (subtypes) | P1 | 3 |
| Navigate to decompiled source | P1 | 3 |
| Navigate to source generator output | P2 | 4 |
| Navigate to metadata as source | P1 | 3 |
| Go to related files | P2 | 4 |
| Breadcrumb / scope bar | P1 | 3 |
| Structural navigation (next/prev member) | P2 | 4 |

### [SHARPLSP-TODO-DIAGNOSTICS] Diagnostics and Analysis

[DIAGNOSTICS-SPEC.md](DIAGNOSTICS-SPEC.md) defines default-enabled P0 solution-wide analysis. SharpLsp-owned monorepo analyzers are specified in [DIAGNOSTICS-STATIC-ANALYZERS-SPEC.md](DIAGNOSTICS-STATIC-ANALYZERS-SPEC.md).

### [SHARPLSP-TODO-REFACTORING] Code Actions and Refactoring

| Feature | Priority | Phase |
| --- | --- | --- |
| All Roslyn built-in code fixes | P0 | 3 |
| All Roslyn built-in refactorings | P0 | 3 |
| Extract method | P0 | 3 |
| Extract variable / constant / field | P0 | 3 |
| Extract interface | P1 | 3 |
| Extract superclass | P2 | 4 |
| Inline variable / method / constant | P1 | 3 |
| Rename symbol (all code elements and references) | P0 | 2 |
| Rename file to match type | P1 | 3 |
| Move type to file | P1 | 3 |
| Move type to namespace | P2 | 4 |
| Safe delete | P2 | 4 |
| Change signature | P2 | 4 |
| Introduce parameter | P2 | 4 |
| Generate constructor | P0 | 3 |
| Generate equals / GetHashCode | P1 | 3 |
| Generate interface implementation | P0 | 3 |
| Generate overrides | P1 | 3 |
| Generate property from field | P1 | 3 |
| Add using / open directive | P0 | 3 |
| Organize usings / opens | P0 | 3 |
| Convert between expression forms | P1 | 3 |
| Surround with (try, if, using, etc.) | P1 | 3 |
| Convert to LINQ / from LINQ | P2 | 4 |
| Convert string concatenation ↔ interpolation | P1 | 3 |
| Convert var ↔ explicit type | P1 | 3 |
| Invert if | P1 | 3 |
| Convert method group ↔ lambda | P1 | 3 |
| Pull members up / push members down | P2 | 4 |
| Convert class to record (C#) | P2 | 4 |
| Convert anonymous type to class/record | P2 | 4 |
| F#: Generate match cases from DU | P1 | 3 |
| F#: Generate record field stubs | P1 | 3 |
| F#: Convert pipe ↔ nested function calls | P1 | 4 |
| F#: Convert to/from computation expression | P2 | 4 |

### [SHARPLSP-TODO-FORMATTING] Formatting and Style

SharpLsp does **not** provide formatting. Use [CSharpier](https://csharpier.com/) for C# and [Fantomas](https://github.com/fsprojects/fantomas) (via [Ionide](https://ionide.io/)) for F#.

### [SHARPLSP-TODO-HIGHLIGHTING] Semantic Highlighting and Visual Features

| Feature | Priority | Phase |
| --- | --- | --- |
| Full semantic tokens | P0 | 2 |
| Delta semantic tokens | P1 | 3 |
| Folding ranges (tree-sitter) | P0 | 1 |
| Selection ranges (tree-sitter) | P0 | 1 |
| Linked editing ranges | P1 | 1 |
| Color information (CSS in Razor) | P3 | 5 |

### [SHARPLSP-TODO-DEBUGGING] Debugging and Testing

> Full debugging feature parity details: [DEBUGGING-SPEC.md](./DEBUGGING-SPEC.md)

| Feature | Priority | Phase |
| --- | --- | --- |
| Launch/attach .NET process | P1 | 4 |
| Breakpoints (line, conditional, logpoint) | P1 | 4 |
| Step in/out/over | P1 | 4 |
| Variable inspection | P1 | 4 |
| Watch expressions | P2 | 4 |
| Call stack navigation | P1 | 4 |
| Async logical call stack | P1 | 4 |
| Exception breakpoints | P2 | 4 |
| Data breakpoints | P2 | 5 |
| Return value display | P2 | 5 |
| Hot reload (method body edits) | P2 | 4 |
| Full expression eval (LINQ, lambdas) | P1 | 5 |
| Remote debugging (SSH) | P2 | 5 |
| Multi-process / compound launch | P2 | 4 |
| Test discovery (xUnit/NUnit/MSTest) | P1 | 4 |
| Test discovery (Expecto/FsCheck) | P1 | 4 |
| Run/debug individual test | P1 | 4 |
| Test result inline display | P2 | 4 |
| Continuous testing | P3 | 5 |
| Code coverage overlay | P3 | 5 |

### [SHARPLSP-TODO-WORKSPACE] Workspace and Project Management

| Feature | Priority | Phase |
| --- | --- | --- |
| Solution/project loading | P0 | 2 |
| SDK-style project support | P0 | 2 |
| Legacy .csproj/.fsproj support | P1 | 3 |
| Multi-targeting support | P1 | 3 |
| Central Package Management | P1 | 3 |
| Project dependency visualization | P2 | 4 |
| NuGet package search & install | P2 | 4 |
| NuGet package update suggestions | P2 | 4 |
| Add/remove project reference | P2 | 4 |
| File watching & auto-reload | P0 | 2 |
| Configuration via sharplsp.toml | P0 | 1 |
| Bundled required sidecars in VSIX | P0 | 1 |

### [SHARPLSP-TODO-FSHARP] F#-Specific Features

| Feature | Priority | Phase |
| --- | --- | --- |
| Pipeline type hints | P1 | 3 |
| Signature file generation (.fsi) | P1 | 4 |
| Union case generation | P1 | 3 |
| Record stub generation | P1 | 3 |
| Computation expression completions | P1 | 3 |
| Type provider navigation | P2 | 4 |
| F# Interactive (FSI) integration | P2 | 4 |
| File ordering awareness & reorder | P1 | 4 |
| Open statement management | P0 | 3 |
| Fantomas integration | P0 | 3 |
| FSharpLint integration | P1 | 4 |
| FSharp.Analyzers.SDK support | P1 | 4 |

### [SHARPLSP-TODO-DIFFERENTIATORS] Differentiating Features

| Feature | Priority | Phase |
| --- | --- | --- |
| Unified C# + F# in one LSP server | P0 | 2 |
| True editor-agnostic (10+ editors) | P0 | 1 |
| Cross-language go-to-definition (C#↔F#) | P2 | 4 |
| Cross-language find references (C#↔F#) | P2 | 4 |
| Zero-config, zero-license instant setup | P0 | 1 |
| Sub-millisecond syntax features (Rust+TS) | P0 | 1 |
| Architecture analysis & visualization | P3 | 5 |
| AI-assisted code actions via MCP | P3 | 5 |
| Database-aware string analysis (SQL) | P3 | 5 |
| Open governance & community-driven | P0 | 1 |


## [SHARPLSP-SUCCESS] Success Metrics

| Milestone | Criteria | Target Date |
|---|---|---|
| Alpha | Completions + diagnostics + go-to-definition working in VS Code for both C# and F# on a real-world solution | Month 8 |
| Beta | All P0 and P1 features working. Usable as a daily driver for C# and F# development | Month 14 |
| 1.0 Release | All P0, P1, P2 features. Performance targets met. 5+ editors verified | Month 20 |
| Community adoption | 1,000+ GitHub stars, 100+ daily active users | Month 24 |
| Feature leadership | Features no other tool has (cross-language nav, AI actions, architecture analysis) | Month 24+ |

## [SHARPLSP-DISTRIBUTION] Distribution

Per-platform VSIX paths and binary resolution are specified by [SHARPLSP-ARCHITECTURE-BINARIES] and [SHARPLSP-ARCHITECTURE-EXTENSIONS]. [DISTRIBUTION-SPEC.md](DISTRIBUTION-SPEC.md) is normative for version invariants, packaging, release workflow, and editor activation.

Under `[DIST-RUNTIME-ACQUIRE]`, the VS Code extension declares `ms-dotnettools.vscode-dotnet-runtime` as an `extensionDependencies` entry and calls `dotnet.acquire` for a per-user .NET 10 runtime. Acquisition MUST show non-interactive progress and a status-bar indicator.
