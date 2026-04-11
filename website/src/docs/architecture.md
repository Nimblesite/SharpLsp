---
layout: layouts/docs.njk
title: Architecture
eleventyNavigation:
  key: Architecture
  order: 2
---

# Architecture

Forge is built on a three-tier architecture that separates concerns between fast syntax operations and rich semantic analysis.

## Tier 1 — Rust LSP Host

The host process handles:

- **LSP protocol**: JSON-RPC over stdio, full LSP 3.17 compliance
- **Virtual File System (VFS)**: In-memory file state with change tracking
- **tree-sitter parsing**: Incremental C# parsing at sub-millisecond speeds (F# grammar integration is pending; F# syntax features route to the sidecar)
- **salsa cache**: Incremental computation — only reprocess what changed
- **Request routing**: Fast syntax requests stay in Rust, semantic requests go to sidecars

## Tier 2 — C# Sidecar (Roslyn)

A long-running .NET 10 process providing:

- MSBuildWorkspace for solution/project loading
- Full Roslyn API: completions, diagnostics, code actions, refactoring
- ICSharpCode.Decompiler for go-to-decompiled-source
- MessagePack serialization over named pipes / Unix domain sockets

## Tier 3 — F# Sidecar (FCS)

A separate .NET 10 process for F# support:

- FSharp.Compiler.Service (`FSharpChecker`) for type checking, hover, and semantic analysis
- MessagePack serialization over the same IPC transport as the C# sidecar

## IPC Protocol

Communication between the Rust host and .NET sidecars uses:

- **MessagePack** binary serialization (compact, fast)
- **Named pipes** (Windows) or **Unix domain sockets** (Linux, macOS)
- **4-byte little-endian length prefix** framing
- Target: <500us round-trip overhead

## Request Routing

| Category | Handler | Latency Target | Examples |
|----------|---------|---------------|----------|
| Syntax-only | Rust (tree-sitter) | <5ms | documentSymbol, foldingRange |
| Semantic | Sidecar | <200ms | completion, hover, definition |
| Hybrid | Rust + Sidecar | <100ms | semanticTokens |
| Cached | Rust (salsa) | <1ms | Repeat requests, unchanged docs |
