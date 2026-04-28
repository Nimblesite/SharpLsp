---
layout: layouts/blog.njk
title: "Introducing SharpLsp: The .NET LSP Built in Rust"
description: "SharpLsp is an open-source, editor-agnostic Language Server for C# and F# — built in Rust, powered by Roslyn and FSharp.Compiler.Service. No licenses. No lock-in. Every editor."
date: 2026-03-20
author: Christian Findlay
authorRole: Principal Distributed Systems Engineer
authorImage: https://lh3.googleusercontent.com/aida-public/AB6AXuAD67SpD-iAx0p3uV9exHCxuwOCzRb4-DL71Un7bMvBZAhwFrV5QujQLJAj7RY1FW-p4m-0uhYkk9PSxb7WJUOqXt25VH6AtubFss0CAMR3Yw9k0n876VF5g0PJXLF0V45EbGUjr7sUPnCLpJC73GhMMZLUuD43uYczJM1_e9IZSX-rZb87fMAJ03X3HR6kzzFuBpQ80EW3hRgYm54AILhIIO2T5pWPyjljM0PWc13wW6tYobl3bdo6v_PSS6a2MMwmRwZTRD5uSw
image: https://lh3.googleusercontent.com/aida-public/AB6AXuBfJIzTeEimCRpV7GypvE1-TXYJhys7tNurDcizpqmeweIvgYAcGvDfJQMYkyK8GyeWzwh8Zf7x9reGpMg9Qb5Snty4u71Sp-8QQwpR1BNC6lgWfhWBktHSVVny_citH4Fs0Hd_MXsisvkjehtT4VfMSsacixiXdPKANztS2iyRo8aD0Zr7gHpA-cdLY5EEH631LhDuiFqhABX7OP5HNINOKcOSg92feCyhshx7Zjq-pydM0cQAxEDZrO59FGzdqriM_ZcT_3Dd9Q
imageAlt: Abstract server rack with glowing green fiber optic cables in dark data center
tags:
  - posts
  - announcement
  - rust
  - csharp
  - fsharp
category: announcement
excerpt: "We are done waiting for Microsoft to fix .NET tooling. SharpLsp is our answer: a Rust-hosted LSP server that delivers first-class C# and F# support in every editor, with zero proprietary dependencies."
---

We are done waiting.

Visual Studio is Windows-only and monolithic. Rider requires a paid license. C# Dev Kit is VS Code-only, closed-source, and treats F# as a non-entity. If you use Neovim, Helix, Emacs, or Zed — you are a second-class citizen in your own ecosystem.

SharpLsp is our answer. An open-source, editor-agnostic Language Server for C# and F# — built in Rust, powered by [Roslyn](https://github.com/dotnet/roslyn) and [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/). MIT licensed. Zero proprietary dependencies. One install that serves every editor on the machine.

## What We Have Built

SharpLsp is not a promise. It is working software. The VS Code extension is the first editor integration, but the architecture is deliberately editor-agnostic from day one — a single `sharplsp-lsp` binary on `$PATH` that any LSP-capable editor can launch.

### Solution Explorer

The first thing you see is a proper Solution Explorer. Not a file tree. A `.sln`-aware hierarchy that understands projects, namespaces, and types — the way Visual Studio does, but available in every editor.

<figure class="article-figure">
  <img src="/assets/screenshots/solution-explorer.png" alt="SharpLsp Solution Explorer showing MyApp.sln with project and namespace tree in VS Code">
  <figcaption>Solution Explorer rendering a real .sln file with full project and type hierarchy.</figcaption>
</figure>

The sidebar also shows code folding that collapses entire namespaces in a single click — the kind of structural view that makes navigating large files bearable.

<figure class="article-figure">
  <img src="/assets/screenshots/code-folding.png" alt="Code folding showing collapsed namespace with 60 lines of code visible in one view">
  <figcaption>Code folding powered by tree-sitter — sub-millisecond, no compiler needed.</figcaption>
</figure>

### Completions

Completions pull from the full Roslyn semantic model. That means import suggestions, extension methods, and full type context — not just the symbols already in scope.

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-completions-page.png" alt="SharpLsp completion list showing Add, Count, and other members with full semantic context">
  <figcaption>Semantic completions powered by Roslyn's CompletionService — the same engine behind Visual Studio.</figcaption>
</figure>

### Hover and XML Doc

Hover shows the full signature, XML documentation, and parameter descriptions. The Profiler panel in the sidebar is visible in every screenshot — SharpLsp surfaces all running .NET processes so you always know what is executing.

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-hover-page.png" alt="Hover tooltip showing Factorial method signature with full XML documentation and parameter descriptions">
  <figcaption>Hover rendering XML doc comments with parameter and return value documentation.</figcaption>
</figure>

### Go to Definition

Go to Definition works across the full solution graph, including nested types and members inside other classes. The breadcrumb bar tracks where you are at all times.

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-go-to-definition-page.png" alt="Go to definition navigating to a method implementation with breadcrumb showing full type path">
  <figcaption>Go to Definition navigating through a multi-level type hierarchy.</figcaption>
</figure>

The Solution Explorer handles deeply nested class structures correctly — inner classes, nested namespaces, all of it reflected accurately in the tree.

<figure class="article-figure">
  <img src="/assets/screenshots/nested-classes.png" alt="Nested classes in the solution explorer showing Outer, Inner, and AnotherInner with reference counts">
  <figcaption>Reference counts and nested type support in the Solution Explorer.</figcaption>
</figure>

### Diagnostics

Diagnostics come from the real Roslyn compiler — not approximations. SharpLsp uses the [LSP 3.17 pull-diagnostics model](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_diagnostic) to avoid the phantom errors that plague other tooling during workspace load. A NuGet restore gate runs before MSBuildWorkspace opens the solution, eliminating the largest class of false CS0246s.

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-diagnostics-page.png" alt="Diagnostics panel showing real Roslyn compiler errors with file and line references">
  <figcaption>Real Roslyn diagnostics, pulled on demand, never pushed prematurely.</figcaption>
</figure>

### Quick Fixes and Refactoring

Code actions come from Roslyn's own CodeFixProviders and CodeRefactoringProviders — the same providers that power Visual Studio. Remove unused variable, rename, extract method — all of it is there because we are calling the same APIs.

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-refactoring.png" alt="Quick fix lightbulb showing Remove unused variable, Fix, and Explain options">
  <figcaption>Roslyn-powered quick fixes surfaced directly in the editor action menu.</figcaption>
</figure>

### Project Context Menu

Right-clicking a project in the Solution Explorer gives you build, rebuild, clean, NuGet browsing, and project reference management — all wired up and working.

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-context-menu-open-project.png" alt="Project context menu showing Build, Rebuild, Clean, Browse NuGet Packages, Add Project Reference options">
  <figcaption>Project-level actions directly from the Solution Explorer context menu.</figcaption>
</figure>

### NuGet Management

The NuGet panel is a full package browser. Search, browse available packages, see what is installed, inspect package details — all without leaving the editor or touching the terminal.

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-nuget-search.png" alt="NuGet browser showing search results for Serilog packages with download counts">
  <figcaption>NuGet package search pulling live results from nuget.org.</figcaption>
</figure>

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-nuget-installed.png" alt="NuGet installed packages panel showing Newtonsoft.Json with description and version">
  <figcaption>Installed packages tab showing what is in the active project.</figcaption>
</figure>

<figure class="article-figure">
  <img src="/assets/screenshots/vscode-nuget-package-details.png" alt="NuGet package detail panel for Newtonsoft.Json showing license, project URL, and version">
  <figcaption>Package details with license, metadata, and install/remove actions.</figcaption>
</figure>

## The Architecture

SharpLsp is a three-tier system. The Rust host owns the LSP connection, the virtual file system, and all syntax-level work via [tree-sitter](https://tree-sitter.github.io/tree-sitter/). Two long-running .NET sidecar processes handle semantic analysis — one for C# via Roslyn, one for F# via FSharp.Compiler.Service.

This is not a compromise. It is the correct design. We do not reimplement type checkers. We call the official compilers. Correctness follows from that decision, not from trying to approximate what Roslyn already knows.

The IPC between Rust and the sidecars uses MessagePack over Unix domain sockets (named pipes on Windows), framed with a 4-byte little-endian length prefix. Round-trip overhead target: under 500µs, excluding compiler work.

Syntax-only requests — document symbols, folding ranges, selection ranges — are handled entirely in the Rust host using tree-sitter. They return in under 5ms regardless of solution size. Semantic requests go to the sidecars and are coalesced with a 150ms debounce window. Stale in-flight requests are cancelled when superseded.

**All SharpLsp binaries live in one central location on the machine.** `sharplsp-lsp` on `$PATH` is all any editor needs. Editor extensions are thin clients that launch the system binary — they contain zero bundled executables. One install serves VS Code, Neovim, Helix, Zed, and every other LSP-capable editor simultaneously.

## F# Is Not a Second-Class Citizen

Every other .NET tool either ignores F# or treats it as an afterthought. SharpLsp does not. C# and F# share the same infrastructure tier. They hit the same feature targets. They are tested to the same standard.

The F# sidecar runs [FSharp.Compiler.Service](https://www.nuget.org/packages/FSharp.Compiler.Service) with [Ionide.ProjInfo](https://github.com/ionide/proj-info) for project cracking and [FSharpLint](https://github.com/fsprojects/FSharpLint) for linting. F#-specific features — pipeline hints, union case generation, record stubs, computation expression completions, file ordering awareness — are on the roadmap as first-priority items, not future nice-to-haves.

## What Is Next

Phase 2 is underway: full semantic analysis for both languages. That means completions, hover, go-to-definition, find-references, diagnostics, rename, and semantic tokens — all working against real MSBuildWorkspace-loaded solutions.

After that: code actions and refactoring (Phase 3), test discovery and debugging (Phase 4), and eventually features no other tool has — cross-language navigation between C# and F# projects, architecture analysis, AI-assisted code actions via MCP (Phase 5).

The full roadmap is in the [technical specification](/docs/specs/sharplsp-spec.md). The code is on [GitHub](https://github.com/Nimblesite/SharpLsp).

SharpLsp exists because .NET developers deserve world-class tooling that is not gated behind proprietary licenses, vendor lock-in, or single-editor coupling. We are building it. Come help.
