---
layout: layouts/blog.njk
title: "Why F# Is First-Class in SharpLsp"
description: "SharpLsp treats F# as a first-class .NET language because the F# community, compiler, tooling stack, and production success stories deserve tooling that is designed for F# from day one."
date: 2026-04-26
author: SharpLsp Team
image: /assets/images/blog/why-fsharp-is-first-class-in-sharplsp.png
imageAlt: Functional programming pipelines and compiler service modules on a circuit board
tags:
  - posts
  - fsharp
  - dotnet-lsp
  - language-server
category: fsharp
excerpt: "F# is not a C# side quest. The language, its community, and its production track record deserve editor tooling that is built around F# semantics from the start."
---

SharpLsp is a .NET language server for C# and F#. That wording is deliberate. F# is not a future compatibility note, a later integration, or a checkbox beside C#.

F# deserves first-class treatment because it is a serious production language with a serious community behind it. Microsoft describes F# as a language for ["succinct, robust and performant code"](https://learn.microsoft.com/en-us/dotnet/fsharp/what-is-fsharp). The official .NET language strategy says F# developers ["simply love working in it"](https://devblogs.microsoft.com/dotnet/the-net-language-strategy/) and states the ambition to make F# the ["best-tooled functional language on the market"](https://devblogs.microsoft.com/dotnet/the-net-language-strategy/).

That is the right ambition. The current editor reality still has a gap.

The same language strategy also said F# tooling ["doesn't quite measure up"](https://devblogs.microsoft.com/dotnet/the-net-language-strategy/) to the richer C# and Visual Basic experience. That was written in 2017, and public community threads since then show a familiar pattern: the language is excellent, the community is excellent, and the day-to-day tooling experience still needs more investment.

SharpLsp exists to make that investment architectural.

## The Community Is Already Doing Heroic Work

Any honest article about F# tooling has to start with respect for the people who built the existing ecosystem. The F# community did not wait around for perfect vendor support. It built tools.

[Ionide](https://ionide.io/index.html) describes itself directly:

> "We build cross platform, F# developer tooling" - [Ionide](https://ionide.io/index.html)

Ionide's flagship VS Code extension has [more than 1 million downloads](https://ionide.io/index.html), and the project documents a real toolchain: [FSAutoComplete](https://ionide.io/Tools/fsac.html), [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/fcs/), Fantomas, FSharpLint, analyzers, project info, and LSP communication. The [Ionide VS Code overview](https://ionide.io/Editors/Code/overview.html) lists the features F# developers expect from a productive editor: autocomplete, go-to-definition, tooltips, rename, refactorings, quick fixes, F# Interactive, workspace errors, project explorer, debugger integration, and more.

That work is not a footnote. It is the reason cross-platform F# development has been viable for years.

The community sees that too:

> Ionide is an absolute treasure.Pioneered so many tooling features that VS and Rider now have too.
>
> - [r/fsharp, "F# Weekly #47, 5 years of Ionide"](https://www.reddit.com/r/fsharp/comments/jy9dgq)

That quote matters because it captures the correct posture: gratitude first. Ionide and FSAutoComplete carried an enormous load. SharpLsp is not a criticism of that work. It is a bet that the next layer of open .NET tooling should learn from it, reuse the right compiler primitives, and give F# a bigger seat in the architecture.

## The Pain Is Also Real

Respect does not require denial. F# developers have been frank about where the experience breaks down.

One r/fsharp user described the VS Code experience this way:

> this does feel very shaky compared to every other language I've worked with.
>
> - [r/fsharp, "Ionide in VS Code (and tooling in general) is pushing me away from F#"](https://www.reddit.com/r/fsharp/comments/t6uyrh)

In the same discussion, the specific failure mode was not abstract:

> Ionide wouldn't stop flagging this code as erroneous until I restarted VSCode altogether.
>
> - [r/fsharp, same thread](https://www.reddit.com/r/fsharp/comments/t6uyrh)

Another user gave a more sympathetic but still conditional assessment:

> ionide f# isnt that bad by comparison if you keep project scaffolding "vanilla".
>
> - [r/fsharp, same thread](https://www.reddit.com/r/fsharp/comments/t6uyrh)

That "if" is the problem. Serious F# users work in real solutions with mixed projects, generated assets, package restore, analyzers, scripts, multiple target frameworks, and build logic. Tooling that works only when the project shape stays simple does not meet the bar for a first-class language.

The theme keeps recurring:

> I love the language and all the rest of the tooling is fantastic at this point, but every time ionide fails to load...
>
> - [r/fsharp, "Ionide doesn't load projects"](https://www.reddit.com/r/fsharp/comments/13wm3gm)

> Yeah the tooling in general feels slower, less reliable than that of more mainstream langs - likely cause less devs, cos, and funding supporting it.
>
> - [r/fsharp, "Why is F# not loved as much as comparable FP-hybrids?"](https://www.reddit.com/r/fsharp/comments/16u52m4)

> The tooling for F# pales in comparison with the tooling for C# though.
>
> - [r/fsharp, "FSharp in VS Code"](https://www.reddit.com/r/fsharp/comments/1bvsyyu)

> TBH I'm finding Visual Studio 2019 a more reliable environment for F# coding, I would prefer to use VS Code...
>
> - [r/fsharp, "No red squiggly lines in VS Code / Ionide"](https://www.reddit.com/r/fsharp/comments/p0bh3z)

Those are anecdotes, not benchmark data. But public anecdotes still matter because they describe the exact user experience SharpLsp has to improve: project loading, stale diagnostics, semantic latency, memory pressure, editor restarts, and confidence that a squiggle means the compiler agrees.

## The Numbers Say Niche, Not Weak

Stack Overflow's 2025 Developer Survey reports F# at [1.3% usage across all respondents and 1.2% among professional developers](https://survey.stackoverflow.co/2025/technology). That is niche. It is not failure.

The same 2025 survey reports F# at [2.9% desired and 49.1% admired](https://survey.stackoverflow.co/2025/technology) in the programming language "Admired and Desired" section. Survey data has limitations, and Stack Overflow's respondent pool is not a census. Still, the signal is consistent with what F# users say in public: F# is a smaller language with a committed user base, not a dead end.

The 2023 analysis ["The State of F#"](https://hamy.xyz/labs/2023-06-state-of-fsharp) made the same basic point from that year's survey data: low usage, high affection, and high salary ranking among respondents. Its conclusion was not that F# is mainstream. It was that F# is a known niche language with users who often want to keep using it.

That is exactly the kind of language where tooling matters most. A large language can survive mediocre editor support through sheer ecosystem gravity. A small language cannot. For F#, great tooling is not polish. It is adoption infrastructure.

## F# Is Semantically Different

F# is not C# with different punctuation. The language has different editing requirements, and those requirements come from real semantics.

Microsoft's F# tooling update for Visual Studio 16.9 explains why semantic editor features are harder in F#: because F# uses type inference, a change in one source file can affect types later in the project or solution. The post is explicit that typechecked-data features are affected by compiler typechecking work, and it calls out downstream effects from changing a union case or a widely used function's output type in a large codebase. It also explains why signature files can improve IDE performance by limiting how much downstream typechecking work is required. Source: [F# and F# tools update for Visual Studio 16.9](https://devblogs.microsoft.com/dotnet/f-and-f-tools-update-for-visual-studio-16-9/).

That single fact has huge consequences for an LSP:

- Project file order is not cosmetic. F# compilation order changes meaning.
- Hover is central because inferred types are often not written in source.
- Completion must understand the typechecker state, not just syntax.
- `.fs`, `.fsi`, and `.fsx` files have different workflows.
- F# Interactive is part of the development loop.
- Signature files are both API design tools and performance tools.
- Type providers and analyzers create language-service pressure that generic C# assumptions do not cover.

The official [FSharp.Compiler.Service documentation](https://fsharp.github.io/fsharp-compiler-docs/fcs/) backs the architectural point. FCS exposes editor services for ["auto-completion, tool-tips, parameter information"](https://fsharp.github.io/fsharp-compiler-docs/fcs/), whole-project analysis, hosting F# Interactive, and embedding the compiler. It is also the compiler-backed foundation used by projects such as F# in Visual Studio, FsAutoComplete, Rider's F# support, .NET Interactive, Fantomas, FSharpLint, Fable, and WebSharper.

In other words: real F# tooling starts at FCS. It does not start with pretending F# can be routed through a C# semantic model.

## Good News Is Happening

F# tooling is not standing still. The F# 10 release, published with .NET 10 in November 2025, includes explicit performance and tooling work.

[Introducing F# 10](https://devblogs.microsoft.com/dotnet/introducing-fsharp-10/) says the release includes a type subsumption cache to accelerate type checking and improve IDE responsiveness, especially in projects with complex type hierarchies. It also describes parallel compilation work grouped under the `ParallelCompilation` project property, `--typecheck-only` support for scripts, and ongoing F# 11 work on performance wins and tooling upgrades.

The F# 10 post also matters because it credits the people doing the work. It says F# is developed through collaboration between the .NET Foundation, F# Software Foundation, members, contributors, and Microsoft, then calls out community contributors for tooling, diagnostics, parser recovery, testing infrastructure, and performance improvements. It also recognizes [Amplifying F#](https://amplifyingfsharp.io/) for supporting contributors.

That is the F# story in one paragraph: a serious compiler, a serious open process, and a community that keeps showing up.

## Production F# Is Not Hypothetical

The case for F# is not just taste. There are real production stories.

The official [F# testimonials](https://fsharp.org/testimonials/) page includes companies and teams using F# in messaging infrastructure, public-records analysis, Microsoft Bing Ads ranking allocation and pricing, Microsoft Research biological computation, insurance calculation, anti-money-laundering, banking, health diagnostics, tax software, rules engines, genomics, satellite systems, and more.

A few examples:

- [Microsoft Bing Ads Ranking Allocation and Pricing](https://fsharp.org/testimonials/) reported that around 95% of the relevant project code was developed in F#.
- [Microsoft Research's Biological Computation group](https://fsharp.org/testimonials/) described F# as its "language of choice for scientific computing".
- [ClearTax](https://fsharp.org/testimonials/) said it built a "whole product from the ground-up in F#".
- [Compositional IT](https://fsharp.org/testimonials/) reported a complex rules and data-transformation release across 90+ markets where "F# just works".
- [CODE Magazine's Jet.com case study](https://www.codemag.com/Article/1611071/F-Microservices-A-Case-Study) presented F# microservices as a "successful, real-world case" of functional programming in production.
- Microsoft's own ["Why you should use F#"](https://devblogs.microsoft.com/dotnet/why-you-should-use-f/) post called out that F# is used for "big things", including Jet.com.
- [G-Research](https://www.gresearch.com/news/going-15-percent-faster-with-graph-based-type-checking-part-two/) has publicly written about validating graph-based type-checking work against all F# projects in a large solution, then proving the same binary output with and without the feature flag.

The wider community has the same lived experience:

> I have a job writing F# (had no knowledge before I got it) in the UK.
>
> - [r/fsharp, "FP languages amongst the highest paying ones according to the StackOverflow Survey 2024"](https://www.reddit.com/r/fsharp/comments/1ec75rn)

> F# has been our primary language for around 6 years now, at least for anything new.
>
> - [r/fsharp, "Who's using F#? What are you using it for?"](https://www.reddit.com/r/fsharp/comments/13m4n7f)

> Me, we, our company, in production.
>
> - [r/dotnet, "Who's using F#? What are you using it for?"](https://www.reddit.com/r/dotnet/comments/13l6coy/question_whos_using_f_what_are_you_using_it_for/)

Those stories are not marketing theater. They are proof that F# is already carrying important work. Tooling should meet the language where it is actually used.

## What First-Class Means in SharpLsp

SharpLsp uses a Rust host process for shared LSP behavior and delegates semantic language work to compiler-backed sidecars:

- C# semantic requests go to a Roslyn sidecar.
- F# semantic requests go to an [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/fcs/) sidecar.
- The host owns routing, cancellation, workspace notifications, sidecar lifecycle, and editor protocol behavior.

That structure is the point. F# gets the compiler service F# needs. C# gets Roslyn. The shared host handles the protocol, filesystem, editor, caching, cancellation, and lifecycle mechanics that should not be duplicated.

For SharpLsp, first-class F# means concrete product requirements:

- F# projects load through F#-aware project evaluation.
- F# diagnostics come from FSharp.Compiler.Service and F# analyzers.
- F# hover, completion, definition, references, rename, and code actions are tracked as real language features.
- F# Interactive workflows are exposed deliberately, not treated as optional extras.
- `.fs`, `.fsi`, and `.fsx` behavior is tested separately.
- F# formatter integration respects Fantomas rather than copying C# formatting assumptions.
- F# lint and analyzer work has a first-class path through the server.
- Mixed C# and F# solutions work without forcing F# into a C# project model.

Some of that is done. Some of it is in progress. The important architectural choice is already made: F# is not a side quest.

## Shared .NET Tooling Still Matters

First-class does not mean isolated. C# and F# projects often live in the same solution. Developers still need one solution view, one build story, one debugger path, one profiler, and one package management surface.

The right model is shared infrastructure where the ecosystem is shared, and dedicated language services where correctness demands it.

That is why SharpLsp has one installed server and dedicated sidecars. The editor should not make developers pick between C# and F# quality. A .NET solution should feel like one solution, with each language getting the compiler intelligence it deserves.

## The Bar

F# support is not complete until F# developers can use SharpLsp as daily tooling without feeling like guests in a C# product.

The F# community has already done its part. It built Ionide, FsAutoComplete, Fantomas, FSharpLint, Fable, FAKE, Paket, analyzers, documentation, talks, tutorials, and production systems. It has kept the language moving through open design, open implementation, and open community support.

SharpLsp's job is to honor that work with architecture, not slogans.

F# is a first-class .NET language. SharpLsp is building accordingly.
