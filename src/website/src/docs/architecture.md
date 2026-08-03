---
layout: layouts/docs.njk
title: Architecture
eleventyNavigation:
  key: Architecture
  order: 2
---

# Architecture

![SharpLsp architecture in VS Code](/assets/screenshots/vscode-architecture-page.png)

SharpLsp separates editor protocol handling from compiler-backed semantic analysis.

{% include "partials/architecture-diagram.njk" %}

## Tier 1 — Rust LSP Host

The host process owns:

- LSP 3.17 JSON-RPC over stdio;
- full-text document synchronization and the in-memory VFS;
- C# tree-sitter parsing for document symbols, folding, selection ranges, linked editing, and syntax pre-validation;
- routing to the correct language sidecar;
- sidecar startup, health checks, restart backoff, and shutdown;
- diagnostic delivery, NuGet request handling, and profiler request handling.

The host currently includes only the C# tree-sitter grammar. F# document and workspace symbols route to FCS; F# folding and selection ranges are not available yet.

Although tree-sitter is designed for incremental parsing, the current full-sync path reparses C# documents from a fresh tree after each change. SharpLsp does not currently depend on salsa.

## Tier 2 — C# Sidecar

A long-running .NET 10 process hosts Roslyn and `MSBuildWorkspace`. It provides C# completion, hover, diagnostics, navigation, references, rename, code actions, semantic tokens, inlay hints, code lens, and hierarchy queries. C# document and workspace symbols are produced by the Rust host's tree-sitter path instead.

A shared ICSharpCode.Decompiler component produces metadata-as-source locations for many BCL and referenced-assembly symbols.

## Tier 3 — F# Sidecar

A separate .NET 10 process hosts `FSharpChecker`. It loads F# project information through SharpLsp's own project/options code and provides F# completion, hover, signature help, diagnostics, navigation, references, rename, symbols, code actions, semantic tokens, inlay hints, code lens, and hierarchy queries.

Fantomas formatting code exists inside the sidecar but is intentionally not routed or advertised by the host. FSharpLint is a dependency but is not connected to the diagnostic pipeline.

## IPC

The host communicates with each sidecar using:

- MessagePack payloads;
- named pipes on Windows or Unix domain sockets on Linux and macOS;
- a 4-byte little-endian length prefix;
- correlated request/response envelopes.

A sidecar failure does not take down the host. The lifecycle manager marks the process unavailable, applies restart backoff, and can start a replacement.

## Request Routing

| Request type | Current route | Examples |
|---|---|---|
| C# syntax | Rust + tree-sitter | document symbols, folding, selection range |
| F# symbols | F# sidecar + FCS | document symbols, workspace symbols |
| C# semantics | C# sidecar + Roslyn | completion, hover, definition, code actions |
| F# semantics | F# sidecar + FCS | completion, hover, definition, signature help |
| Host services | Rust | diagnostics delivery, NuGet orchestration, profiling |

Formatting is not advertised for either language. Use CSharpier for C# and a dedicated Fantomas integration for F#.

Latency values elsewhere in the project are engineering targets, not guarantees for every repository, machine, or cold-start state.
