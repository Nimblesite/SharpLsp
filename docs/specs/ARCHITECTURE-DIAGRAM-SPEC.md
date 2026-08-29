# Architecture Diagram `[ARCH-DIAGRAM]`

Visual companion to [`[SHARPLSP-ARCHITECTURE]`](SHARPLSP-SPEC.md#sharplsp-architecture-architecture)
in [SHARPLSP-SPEC.md](SHARPLSP-SPEC.md). This document is **diagram-only**: it does not restate
tier responsibilities, transport properties, routing tables, or lifecycle rules — those live in
`[SHARPLSP-ARCHITECTURE-TIERS]`, `[SHARPLSP-ARCHITECTURE-IPC]`,
`[SHARPLSP-ARCHITECTURE-ROUTING]` and `[SHARPLSP-ARCHITECTURE-SIDECARS]`, which are the source
of truth. Everything here maps a spec concept onto the code that implements it.

## `[ARCH-DIAGRAM-TIERS]` VSIX → LSP host → Roslyn/FCS

```mermaid
flowchart TB
    subgraph EDITOR["VS Code (host process)"]
        UI["Editor UI<br/>Solution Explorer · Test Explorer · NuGet Browser"]
        subgraph VSIX["sharplsp.vsix — TypeScript extension"]
            EXT["extension.ts<br/>activation · signals reactivity"]
            INSTALL["install.ts<br/>Shipwright binary download + version pin"]
            CLIENT["client.ts<br/>vscode-languageclient<br/>TransportKind.stdio"]
            EXTRA["tree.ts · testing.ts · nuget.ts · debug.ts<br/>custom LSP requests + DAP"]
        end
    end

    subgraph HOST["Tier 1 — Rust LSP Host (sharplsp binary)"]
        LSP["main.rs — lsp-server<br/>JSON-RPC loop"]
        ROUTE{"handlers.rs<br/>request routing"}
        SYNTAX["tree-sitter (C# + F#)<br/>documentSymbol · foldingRange<br/>selectionRange &lt;5ms"]
        VFS["vfs.rs<br/>document state"]
        CACHE["nav_cache · semantic_tokens<br/>TokenCache"]
        MGR["sidecar/manager.rs<br/>spawn · health ping · restart<br/>request correlation + timeouts"]
        FRAME["sidecar/transport.rs + protocol.rs<br/>Envelope · 4-byte LE length prefix"]
    end

    subgraph SIDECARS["Tiers 2 &amp; 3 — .NET Sidecars (net10.0)"]
        subgraph CS["SharpLsp.Sidecar.CSharp"]
            HOSTCS["SidecarHost (Common)"]
            ROSLYN["Roslyn<br/>MSBuildWorkspace · Compilation<br/>SemanticModel · CodeFixes<br/>ICSharpCode.Decompiler"]
        end
        subgraph FS["SharpLsp.Sidecar.FSharp"]
            HOSTFS["SidecarHost (Common)"]
            FCS["FSharp.Compiler.Service<br/>FSharpChecker · Fantomas · FSharpLint"]
        end
    end

    DISK[(".sln / .csproj / .fsproj<br/>NuGet packages · MSBuild")]

    UI --> EXT
    EXT --> INSTALL
    EXT --> CLIENT
    EXT --> EXTRA
    EXTRA -.custom requests.-> CLIENT
    INSTALL -. downloads/launches .-> LSP

    CLIENT <-->|"LSP 3.17 over stdio<br/>JSON-RPC"| LSP
    LSP --> ROUTE
    ROUTE -->|syntax-only| SYNTAX
    ROUTE -->|cached &lt;1ms| CACHE
    SYNTAX --- VFS
    ROUTE -->|"semantic · hybrid"| MGR
    MGR --> FRAME

    FRAME <-->|"MessagePack over<br/>Unix domain socket / named pipe<br/>&lt;500µs target"| HOSTCS
    FRAME <-->|"MessagePack over<br/>Unix domain socket / named pipe"| HOSTFS

    HOSTCS --> ROSLYN
    HOSTFS --> FCS
    ROSLYN --> DISK
    FCS --> DISK

    ROSLYN -.diagnostics · completions · hover<br/>definition · references · rename.-> FRAME
    FCS -.same surface, F#.-> FRAME
    FRAME -.publishDiagnostics.-> LSP
```

## `[ARCH-DIAGRAM-BOUNDARIES]` What the diagram asserts

- **The VSIX never talks to Roslyn.** It speaks LSP (plus custom requests) to the Rust host
  over **stdio** only. Beyond that its jobs are binary acquisition and UI surfaces.
- **The Rust host is the router.** Syntax-only work is answered locally from tree-sitter;
  semantic work is forwarded to a sidecar. See `[SHARPLSP-ARCHITECTURE-ROUTING]`.
- **Two protocols, not one.** Editor↔host is JSON-RPC/LSP over stdio; host↔sidecar is
  MessagePack `Envelope` frames with a 4-byte little-endian length prefix over Unix domain
  socket / named pipe. See `[SHARPLSP-ARCHITECTURE-IPC]`.
- **C# and F# are peers.** Both sidecars share `SharpLsp.Sidecar.Common`'s `SidecarHost` and
  the same RPC surface. Neither is primary. Process isolation per `[SHARPLSP-ARCHITECTURE-SIDECARS]`.

## `[ARCH-DIAGRAM-CODE-MAP]` Node → implementation

| Diagram node | Implementation |
|---|---|
| `client.ts` — stdio transport | [src/editors/vscode/src/client.ts:53](../../src/editors/vscode/src/client.ts#L53) |
| `install.ts` — binary acquisition | [src/editors/vscode/src/install.ts](../../src/editors/vscode/src/install.ts) |
| Custom requests + DAP | [tree.ts](../../src/editors/vscode/src/tree.ts), [testing.ts](../../src/editors/vscode/src/testing.ts), [nuget.ts](../../src/editors/vscode/src/nuget.ts), [debug.ts](../../src/editors/vscode/src/debug.ts) |
| `main.rs` — JSON-RPC loop | [src/sharplsp/src/main.rs](../../src/sharplsp/src/main.rs) |
| Request routing | [src/sharplsp/src/handlers.rs](../../src/sharplsp/src/handlers.rs) |
| tree-sitter parsing | [src/sharplsp/src/tree_sitter_parse.rs](../../src/sharplsp/src/tree_sitter_parse.rs), [src/sharplsp/src/syntax.rs](../../src/sharplsp/src/syntax.rs) |
| Document state (VFS) | [src/sharplsp/src/vfs.rs](../../src/sharplsp/src/vfs.rs) |
| Caches | [src/sharplsp/src/nav_cache.rs](../../src/sharplsp/src/nav_cache.rs), [src/sharplsp/src/semantic_tokens.rs](../../src/sharplsp/src/semantic_tokens.rs) |
| Sidecar lifecycle, `[SIDECAR-IPC-TIMEOUT]` | [src/sharplsp/src/sidecar/manager.rs](../../src/sharplsp/src/sidecar/manager.rs) |
| Framing + envelope | [src/sharplsp/src/sidecar/transport.rs](../../src/sharplsp/src/sidecar/transport.rs), [src/sharplsp/src/sidecar/protocol.rs](../../src/sharplsp/src/sidecar/protocol.rs) |
| Shared sidecar host | [src/sidecars/SharpLsp.Sidecar.Common/SidecarHost.cs](../../src/sidecars/SharpLsp.Sidecar.Common/SidecarHost.cs) |
| C# sidecar (Roslyn) | [src/sidecars/SharpLsp.Sidecar.CSharp/](../../src/sidecars/SharpLsp.Sidecar.CSharp/) |
| F# sidecar (FCS) | [src/sidecars/SharpLsp.Sidecar.FSharp/](../../src/sidecars/SharpLsp.Sidecar.FSharp/) |
| Diagnostics publication | [src/sharplsp/src/diagnostics.rs](../../src/sharplsp/src/diagnostics.rs), [src/sharplsp/src/pull_diagnostics.rs](../../src/sharplsp/src/pull_diagnostics.rs) |
| Test Explorer, `[TEST-EXPLORER]` | [src/editors/vscode/src/testing.ts](../../src/editors/vscode/src/testing.ts), [src/editors/vscode/src/test-discovery.ts](../../src/editors/vscode/src/test-discovery.ts), [src/editors/vscode/src/test-execution.ts](../../src/editors/vscode/src/test-execution.ts) |
