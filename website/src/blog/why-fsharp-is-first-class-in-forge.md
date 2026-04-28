---
layout: layouts/blog.njk
title: "Why F# Is First-Class in Forge"
description: "Forge treats F# as a first-class .NET language by designing the LSP around a dedicated FSharp.Compiler.Service sidecar, not a later C#-only bolt-on."
date: 2026-04-26
author: Forge Contributors
authorRole: F# Language Engineer
authorImage: https://lh3.googleusercontent.com/aida-public/AB6AXuAD67SpD-iAx0p3uV9exHCxuwOCzRb4-DL71Un7bMvBZAhwFrV5QujQLJAj7RY1FW-p4m-0uhYkk9PSxb7WJUOqXt25VH6AtubFss0CAMR3Yw9k0n876VF5g0PJXLF0V45EbGUjr7sUPnCLpJC73GhMMZLUuD43uYczJM1_e9IZSX-rZb87fMAJ03X3HR6kzzFuBpQ80EW3hRgYm54AILhIIO2T5pWPyjljM0PWc13wW6tYobl3bdo6v_PSS6a2MMwmRwZTRD5uSw
image: https://lh3.googleusercontent.com/aida-public/AB6AXuD3cenwQpbnyBBi929ng2j1r3C0jyseH8LD8FljraY1UsoybKPdgLyJelH3xTgzcaGIDXvP2SOhX7iipv-AaBtDsMqb1v2Quoza3LNm6nEFcoZNRdiGglQU0ZFZjVmkrA7CKrOC7jXhWuR0smaSe5IMksK2UsIompgrn0Yzm2ANJ-Gla-6Ey4-DB7KlbjjNZ6Z4DElKRlX1RQsg2AFYrKjI6gewCnbGUycXtZIeJ6YIvoNyZwH5WZgcuYGi__KGyLSc08QHoLeVVg
imageAlt: Close up of mechanical keyboard with glowing keys in dark environment
tags:
  - posts
  - fsharp
  - dotnet-lsp
  - language-server
category: fsharp
excerpt: "First-class F# support has to be architectural. It cannot be patched in after a C#-only server is finished."
---

Forge is a .NET language server for C# and F#. That wording is deliberate. F# is not a future compatibility note, an integration afterthought, or a checkbox beside C#.

First-class F# support has to be designed into the language server architecture from the beginning. If the project model, request routing, testing strategy, and editor UX are all built around C# first, F# eventually becomes a fragile adapter around someone else's assumptions.

Forge avoids that by giving F# its own semantic sidecar and equal status in the LSP host.

## F# Has Different Tooling Requirements

F# is not C# with different syntax. The compiler pipeline, file ordering rules, interactive workflows, signature files, pipeline-heavy code style, and type inference ergonomics all require language-specific handling.

That affects ordinary editor behavior:

- Project file order matters for compilation.
- Hover and completion often need inferred types to be displayed clearly.
- `.fs`, `.fsx`, and `.fsi` files need different workflows.
- F# Interactive is a core development loop, not a novelty.
- Formatter and analyzer expectations are different from C#.

A serious .NET LSP has to respect those differences while still sharing infrastructure where sharing is useful.

## Forge's Sidecar Model

Forge uses a Rust host process for shared LSP behavior and delegates semantic language work to compiler-backed sidecars:

- C# semantic requests go to a Roslyn sidecar.
- F# semantic requests go to an [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/) sidecar.
- The host owns routing, cancellation, workspace notifications, sidecar lifecycle, and editor protocol behavior.

That gives each language the compiler service it needs without splitting Forge into two unrelated products. The shared host can still enforce common behavior: one install location, one `forge-lsp` entrypoint, one protocol surface, and one editor integration story.

## What First-Class Means in Practice

For Forge, first-class F# means more than opening `.fs` files without crashing. It means F# features must have their own acceptance criteria:

- F# projects load through F#-aware project evaluation.
- F# diagnostics come from FSharp.Compiler.Service and F# analyzers.
- F# hover, completion, definition, references, rename, and code actions are tracked as real language features.
- F# Interactive commands are exposed as editor workflows.
- F# test coverage is not treated as optional because the C# path passes.

Some of this is already represented in the extension manifest and the technical specs. Some of it is still in progress. The important part is that the architecture leaves room for correctness instead of forcing F# through a C# tunnel.

## Shared .NET Tooling Still Matters

First-class does not mean isolated. C# and F# projects often live in the same solution. Developers still need one Solution Explorer, one build story, one debugger path, one profiler, and one package management surface.

Forge's job is to make those shared workflows feel coherent while still letting language-specific compiler services answer language-specific questions.

That is the shape of a real open-source .NET IDE backend: shared infrastructure where the ecosystem is shared, dedicated language services where correctness demands it.

## The Bar

F# support is not complete until F# developers can use Forge as their daily tooling without feeling like guests in a C# product.

That is the standard Forge is building toward.
