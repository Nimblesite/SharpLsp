---
layout: layouts/blog.njk
title: "Introducing SharpLsp: The .NET LSP Built in Rust"
description: "SharpLsp is an open-source, editor-agnostic Language Server for C# and F# — built in Rust, powered by Roslyn and FSharp.Compiler.Service. No licenses. No lock-in. Every editor."
date: 2026-03-20
author: Christian Findlay
image: /assets/images/blog/introducing-sharplsp.png
imageAlt: Rust host engine connected to C# and F# sidecar modules
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

The .NET developer experience outside of Windows is broken. Not theoretically — provably, in public, with 1,035 thumbs down on a single GitHub announcement and a retirement post that told Mac developers to run Windows in a VM. SharpLsp is the community's answer: an open-source, editor-agnostic Language Server for C# and F# — built in Rust, powered by [Roslyn](https://github.com/dotnet/roslyn) and [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/). MIT licensed. Zero proprietary dependencies. One install that serves every editor on the machine.

## The Situation Is Worse Than You Think

Every option available to a .NET developer today has a disqualifying flaw. Not a quirk — a structural problem that cannot be patched away.

### Visual Studio: Windows Only, Full Stop

Visual Studio remains Windows-only. In August 2023, Microsoft announced the retirement of Visual Studio for Mac, effective August 31, 2024. The [official retirement post](https://devblogs.microsoft.com/visualstudio/visual-studio-for-mac-retirement-announcement/) listed the alternatives for Mac developers who need F#:

> **"Visual Studio IDE running on Windows in a VM on Mac: This option will cover the broadest IDE needs such as legacy project support for Xamarin, F#, and remote development experiences on iOS by using a virtual machine (VM)."**

That is not a workaround. That is Microsoft telling F# developers on Mac to run a foreign operating system inside their computer to write code in their language of choice. It was a clear signal: if you are on macOS or Linux and you use F#, you are not a priority.

### C# Dev Kit: Closed Core, Enterprise Paywall, VS Code Only

The replacement Microsoft offered was [C# Dev Kit](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit). It shipped in 2023 to a hostile reception. In [GitHub issue #5276](https://github.com/dotnet/vscode-csharp/issues/5276) — the roadmap announcement where Microsoft revealed the extension would contain closed-source components — the community left **1,035 thumbs-down reactions against 87 thumbs-up**. That is a 12-to-1 rejection ratio on Microsoft's own repository.

The comments were unambiguous. One developer wrote:

> *"It's sad and short-sighted when Microsoft tries to jockey for power in the short-run (or reap rewards on existing market share) by making user-hostile decisions."* (245 👍)

Another:

> *"MS has gained a ton of goodwill from developers by building open source, it would be a shame for this to change and old habits come back in to play."* (178 👍)

And a third, with 435 upvotes — the most-liked comment in the thread:

> *"I feel like Microsoft has noticed the amount of installs the C# extension has and has to step (aka embrace) in... Will all these installs automatically switch to the closed-source part of the extension? I would rather see a new extension in the Visual Studio Marketplace... Luckily we still have Rider, so we have at least one IDE/Editor for C# that is not owned by Microsoft."*

The closed-source core was not the only problem. The [C# Dev Kit license](https://marketplace.visualstudio.com/items/ms-dotnettools.csdevkit/license) contains a hard enterprise restriction:

> *"If you are an Enterprise, your users may not use the Software to develop or test your applications, except for: (1) open source; and (2) education purposes."*

An "Enterprise" is defined as any organization with more than 250 users **or** more than $1,000,000 USD in annual revenue. That means any profitable small business, any mid-sized team, any funded startup — all of them need a paid Visual Studio subscription to use C# Dev Kit commercially. The extension had 16 million installs. Most of those users do not know they need a commercial license.

C# Dev Kit is also **VS Code only**. It will not work in Neovim, Helix, Emacs, Zed, or any other LSP-capable editor. And as one developer noted in the issue thread:

> *"I assume that Microsoft won't make extensions for these editors."*

They were right. Microsoft confirmed it — no change to debugger licensing, no support planned for non-VS Code editors.

### OmniSharp: The Community's Orphan

OmniSharp was the open-source workhorse that powered the old C# extension for years. It worked across editors, it was MIT licensed, and it was community-maintained. When Microsoft announced the transition to the new closed-source LSP host, community contributors noted that OmniSharp's primary developers were Microsoft employees — meaning the "community" project was staffed by one company. As one observer put it in the same thread:

> *"We'll see how much love the open-source LSP server will get but I don't have much hope. This year, JoeRobich and 50Wliu have made the most commits and are both working at Microsoft."*

OmniSharp's future is now tied to whether Microsoft's internal priorities align with keeping it alive. That is not independence. That is dependency with extra steps.

### Rider: Excellent but Proprietary

JetBrains Rider is the best IDE available for .NET outside of Visual Studio. That is a genuine compliment. But it requires a paid subscription, it is a closed-source product, and your workflow depends on JetBrains keeping it commercially viable. If they raise prices, change the licensing model, or discontinue it — you have no recourse. The community has no ownership.

One developer in issue #5276 expressed exactly this concern:

> *"Closed tools all get sunset eventually, then we'll have to port all our code. I've worked at places where my whole job was porting from some closed source language that's no longer supported. Better to do it on your own schedule than be forced to unexpectedly. At least with omnisharp there was a plan."*

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

## F# Is Not an Afterthought

Microsoft's retirement post told F# developers on Mac to run a Windows VM. C# Dev Kit has no F# support at all. OmniSharp's F# story has always been an afterthought. The community has accepted this for years because there was no alternative. SharpLsp refuses to accept it.

C# and F# share the same infrastructure tier. They hit the same feature targets. They are tested to the same standard. F# is not a bolt-on — it is a first-class target from day one.

The F# sidecar runs [FSharp.Compiler.Service](https://www.nuget.org/packages/FSharp.Compiler.Service) with [Ionide.ProjInfo](https://github.com/ionide/proj-info) for project cracking and [FSharpLint](https://github.com/fsprojects/FSharpLint) for linting. F#-specific features — pipeline hints, union case generation, record stubs, computation expression completions, file ordering awareness — are on the roadmap as first-priority items, not future nice-to-haves.

When we build a new feature, we build it for F# first.

## Why Open Source Ownership Matters

The community's frustration with the #5276 announcement was not just about open-source ideology. It was about control. As one developer wrote, with 99 upvotes:

> *"This kind of rug pull with open source projects isn't welcome at all. I hope you fix this before it turns into a PR disaster. This kind of behavior makes me embarrassed to have an open source project relying 100% on .NET."*

Closed tools get sunset. Licenses get changed. Companies pivot. The only durable answer for a developer ecosystem is tooling that the community owns — where the source code exists, where anyone can fork it, where no single company can change the terms of use overnight.

SharpLsp is MIT licensed. The full source is on [GitHub](https://github.com/Nimblesite/SharpLsp). There are no closed-source components, no enterprise license restrictions, no Microsoft account requirements. No one needs permission to use it commercially. No organization of any size is excluded from using it. There is nothing to sign.

## What Is Next

Phase 2 is underway: full semantic analysis for both languages. That means completions, hover, go-to-definition, find-references, diagnostics, rename, and semantic tokens — all working against real MSBuildWorkspace-loaded solutions.

After that: code actions and refactoring (Phase 3), test discovery and debugging (Phase 4), and eventually features no other tool has — cross-language navigation between C# and F# projects, architecture analysis, AI-assisted code actions via MCP (Phase 5).

The full roadmap is in the [technical specification](/docs/specs/sharplsp-spec.md). The code is on [GitHub](https://github.com/Nimblesite/SharpLsp).

SharpLsp exists because .NET developers deserve world-class tooling that is not gated behind proprietary licenses, vendor lock-in, or single-editor coupling. We are building it. Come help.
