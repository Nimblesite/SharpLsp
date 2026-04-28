---
layout: layouts/blog.njk
title: "Why .NET Needs an Editor-Agnostic LSP"
description: "Forge is building an open-source .NET LSP for C# and F# so language tooling can work across VS Code, Zed, Neovim, Helix, Emacs, Rider, and more."
date: 2026-04-28
author: Forge Contributors
tags:
  - posts
  - dotnet-lsp
  - language-server
category: architecture
excerpt: "A .NET language server should be a platform capability, not a feature trapped inside one editor."
---

Forge is an open-source .NET language server for C# and F#. The point is not to make one more VS Code extension. The point is to make the .NET development experience portable across every editor that can speak the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/).

The current Forge alpha uses VS Code as the primary working surface because it gives us a fast way to test real workflows: solution loading, C# completions, hover, go-to-definition, diagnostics, NuGet commands, profiler commands, and debugger integration. But the architecture is not VS Code-shaped. VS Code is a client. Forge is the language tooling platform behind it.

## The Problem Is Coupling

.NET developers should not have to pick their editor based on where the best C# and F# tooling is locked. Some teams use Visual Studio. Some use Rider. Some use VS Code. Others work in Zed, Neovim, Helix, Emacs, or mixed environments where no single editor can be mandated.

That matters because editor coupling creates operational friction:

- Settings, keybindings, and project workflows become editor-specific knowledge.
- Teams lose tooling consistency when contributors use different editors.
- Extension code becomes the place where language behavior leaks, forks, and diverges.
- F# support is easy to postpone when the product is optimized around C# in one host.

Forge treats the editor as a shell around a shared language service. The LSP server owns the behavior. Editor extensions should stay thin.

## What "Editor-Agnostic" Means in Forge

Forge is built around one installed `forge-lsp` binary. Editor clients find it on `PATH` and launch it over standard input/output. The same server handles C#, F#, solution discovery, semantic requests, diagnostics, and custom Forge requests.

The repository already reflects that split:

- The Rust host owns the LSP connection, virtual file system, request routing, tree-sitter syntax work, and sidecar lifecycle.
- The C# sidecar hosts [Roslyn](https://github.com/dotnet/roslyn) for semantic C# features.
- The F# sidecar hosts [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/) for semantic F# features.
- Editor extensions expose native UI affordances while calling into the same server behavior.

This is why the VS Code extension can provide a Solution Explorer and profiler view while the same `forge-lsp` can still serve editors that only support standard LSP capabilities.

## Why Rust in the Host

The Rust process is responsible for the hot path: protocol handling, document state, cancellation, syntax-level routing, and process supervision. Those jobs need predictable latency and careful concurrency. Rust is a practical fit for that work.

Forge does not try to rewrite the C# or F# compilers in Rust. Correct semantic behavior belongs to the official compiler stacks. The host routes requests to Roslyn and FSharp.Compiler.Service when the answer depends on symbols, types, project references, analyzers, or compiler services.

That split keeps the server fast without pretending compiler correctness can be approximated.

## What This Enables

An editor-agnostic .NET LSP creates one integration point for features that normally fragment by editor:

- C# and F# language intelligence from the same installed server
- Solution and project understanding through shared Forge requests
- NuGet workflows that do not live only in a webview implementation
- Profiler and debugger commands that can grow beyond one extension host
- Consistent diagnostics and navigation semantics across editors

The alpha is still focused on making the VS Code path solid first. That is the right proving ground. The long-term target is broader: one open-source .NET tooling stack, one server, every editor.

## The Standard Is Simple

Forge should be judged by whether it makes real .NET work better: opening a solution, navigating code, fixing errors, managing packages, profiling a running process, and debugging without being forced into a proprietary toolchain.

The editor should be a preference. The language tooling should be infrastructure.
