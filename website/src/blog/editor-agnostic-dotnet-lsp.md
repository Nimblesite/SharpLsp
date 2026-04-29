---
layout: layouts/blog.njk
title: "Why .NET Needs an Editor-Agnostic LSP"
description: "SharpLsp is building an open-source .NET LSP for C# and F# so language tooling can work across VS Code, Zed, Neovim, Helix, Emacs, Rider, and more."
date: 2026-04-28
author: SharpLsp Team
image: /assets/images/blog/editor-agnostic-dotnet-lsp.png
imageAlt: Multiple editor windows connected to one central language server core
tags:
  - posts
  - dotnet-lsp
  - language-server
category: architecture
excerpt: "A .NET language server should be a platform capability, not a feature trapped inside one editor — and right now, every option has a catch."
---

SharpLsp is an open-source .NET language server for C# and F#. The point is not to make one more VS Code extension. The point is to make the .NET development experience portable across every editor that can speak the [Language Server Protocol](https://microsoft.github.io/language-server-protocol/) — and to make it genuinely competitive with the best tooling on any platform.

That goal matters more than ever, because right now every option .NET developers have comes with a serious catch.

## Visual Studio Is Windows-Only. Full Stop.

Visual Studio is the gold standard for C# tooling. Roslyn integration, a world-class profiler, XAML designer, Test Explorer, Edit and Continue — it is the benchmark everything else is measured against. And it runs exclusively on Windows.

Microsoft confirmed this definitively in August 2024 when they [retired Visual Studio for Mac](https://devblogs.microsoft.com/visualstudio/visual-studio-for-mac-retirement-announcement/). Their recommended path for Mac developers was either C# Dev Kit for VS Code, or — and this is the telling part — **running full Windows Visual Studio inside a virtual machine**:

> "Visual Studio IDE running on Windows in a VM on Mac: This option will cover the broadest IDE needs such as legacy project support for Xamarin, F#, and remote development experiences."

Read that again. The official Microsoft recommendation for F# developers on Mac is to run a Windows VM. That is not a cross-platform story. That is a concession that Windows is the platform and everything else is a workaround.

## C# Dev Kit Is Not a Replacement

When Microsoft retired Visual Studio for Mac, they pointed developers at [C# Dev Kit](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit) as the alternative. But the community verdict has not been kind.

C# Dev Kit currently has a **[low user rating](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit) on the VS Marketplace** — from Microsoft's own first-party extension. Recent reviews tell the story:

> "That just not works out of the box or after basic tinkering. Especially on macOS or Linux... Connection to LSP server just crashes and throws errors." — DKchshv, March 2026

> "It can't find installed .Net runtimes. Isn't this the very first thing it was supposed to do?" — Emre Gönültaş, February 2026

> "Installing package 'Language server for Roslyn Copilot integration'. I did not ask for Copilot Integration. I do not want Copilot Integration. I was not asked if I wanted to opt-in. I am not presented with any option to disable it. Disgusting business practice." — Matt Kaczmarek, April 2026

And then there is the licensing. C# Dev Kit is [not free for enterprise teams](https://marketplace.visualstudio.com/items/ms-dotnettools.csdevkit/license). Any organisation with more than 250 users or over $1 million in annual revenue is classified as an "Enterprise" and **cannot use C# Dev Kit to develop commercial applications without a paid Visual Studio subscription**. An open-source developer gets it for free. A commercial team does not.

Beyond reliability and licensing, the feature gap is real. C# Dev Kit has no CPU profiler. No memory profiler. No performance analysis tooling of any kind. In Visual Studio these are core IDE features. In C# Dev Kit they simply do not exist.

When the roadmap announcement for the new LSP-based extension landed on GitHub in 2022, the community made its feelings known: [**1,035 thumbs-down reactions**](https://github.com/dotnet/vscode-csharp/issues/5276) — the most negative reception of any announcement in the repository's history — after Microsoft revealed the new host component would include closed-source pieces. The anger was not irrational. Developers who had built their workflows on OmniSharp, an open-source project, were being told the replacement would mix in proprietary components they had no visibility into.

## Rider Is Good — But It Is a Different World

JetBrains Rider is a serious IDE. Excellent F# support, cross-platform, real profiler, deep Roslyn integration. If you are comfortable with IntelliJ-style IDEs and willing to pay for a subscription, Rider is a genuine option.

But Rider is a completely different development environment from VS Code. Teams that mix editors — some members on VS Code, some on Neovim, some on Zed — cannot share a Rider-based workflow. Rider's .NET intelligence lives inside Rider. It does not expose a standard LSP server that other editors can consume. If you leave Rider, you leave its tooling behind entirely.

## F# Is Treated as a Second-Class Citizen

F# is a world-class language for line-of-business applications. Strong typing, algebraic data types, computation expressions, and a compiler that catches an enormous class of bugs before they reach production. Enterprises building financial systems, data pipelines, and domain-heavy applications have excellent reasons to reach for F#.

The tooling support tells a different story.

Visual Studio's F# support trails C# by years. Rider does better. Ionide for VS Code is a community-maintained extension doing serious work with real constraints. But there is no story — from Microsoft or anyone else — that puts F# tooling on equal footing with C# across all editors. F# is always the afterthought, the bolt-on, the feature that gets deferred when the C# roadmap fills up.

Microsoft's own retirement announcement acknowledged this plainly. When they listed what Visual Studio for Mac would lose, F# was called out specifically as a reason to run a Windows VM instead.

## The Platform Problem

What all of this adds up to is a fractured .NET developer experience:

- **Windows**: Use Visual Studio. Best-in-class tooling, but platform-locked.
- **macOS/Linux with VS Code**: Use C# Dev Kit, accept the reliability problems, accept the licensing constraints, accept no profiler, and accept that F# is secondary.
- **macOS/Linux wanting full tooling**: Use Rider, accept the subscription cost and that it's a walled ecosystem.
- **Neovim, Helix, Zed, Emacs**: Accept whatever the community has managed to wire together from OmniSharp or clangd-inspired setups, because no official server targets you.

No single open-source, cross-platform, editor-agnostic .NET language server exists that delivers the full picture.

## What SharpLsp Is Building

SharpLsp is built around one installed `sharplsp-lsp` binary. Editor clients find it on `PATH` and launch it over standard input/output. The same server handles C#, F#, solution discovery, semantic requests, diagnostics, and custom SharpLsp requests.

The architecture is deliberately split:

- The **Rust host** owns the LSP connection, virtual file system, request routing, tree-sitter syntax work, and sidecar lifecycle.
- The **C# sidecar** hosts [Roslyn](https://github.com/dotnet/roslyn) for semantic C# features.
- The **F# sidecar** hosts [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/) for semantic F# features.
- **F# is not a bolt-on.** F# features are built ahead of C# features where we can, and F# is a first-class target from day one.

This is why the VS Code extension can provide a Solution Explorer and profiler view while the same `sharplsp-lsp` can still serve editors that only support standard LSP capabilities.

The alpha is focused on making the VS Code path solid first — that is the right proving ground. The long-term target is one open-source .NET tooling stack, one server, every editor, with a profiler.

## What This Looks Like in Practice

An editor-agnostic .NET LSP means:

- **C# and F# language intelligence** from the same installed server, on macOS, Linux, and Windows, with no VM required
- **No per-seat licensing.** Open source. No Enterprise carve-outs.
- **A profiler that works** — not locked inside Visual Studio or behind a Rider subscription
- **Consistent diagnostics and navigation semantics** whether you are in VS Code, Zed, Neovim, or Helix
- **F# treated as the language it is** — not deferred until after C# is "done"

The .NET ecosystem is too good to be held hostage to Windows, or to a low-rated first-party extension, or to a single commercial IDE vendor.

## The Standard Is Simple

SharpLsp should be judged by whether it makes real .NET work better: opening a solution, navigating code, fixing errors, managing packages, profiling a running process, and debugging — without being forced into a proprietary toolchain or a Windows VM.

The editor should be a preference. The language tooling should be infrastructure.
