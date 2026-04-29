---
layout: layouts/blog.njk
title: "Diagnostic Accuracy: Errors You Can Trust"
description: "SharpLsp uses LSP 3.17 pull diagnostics to deliver solution-wide error accuracy — showing every real Roslyn and analyzer error, and nothing that isn't real."
date: 2026-04-27
author: SharpLsp Team
image: /assets/images/blog/pull-diagnostics-without-phantom-errors.png
imageAlt: Compiler diagnostics flowing through filters that remove false error signals
tags:
  - posts
  - diagnostics
  - csharp
  - lsp
category: diagnostics
excerpt: "Diagnostics are only useful when developers can trust them completely. SharpLsp's goal is total accuracy: every real error shown, every false positive eliminated."
---

Diagnostics are the developer feedback loop. The Problems panel is the place developers look to understand whether their code is correct. If it shows errors that do not exist, developers start ignoring it. If it misses errors that will break the build, developers get surprised in CI. Both failure modes destroy trust in the tooling.

SharpLsp's diagnostic architecture has a single goal: **accuracy**. Every error the compiler or an analyzer would report must appear in the editor. Every error that would not appear in a real build must be absent. The Problems panel should reflect exactly what `dotnet build` would tell you — no more, no less.

That sounds simple. In practice it requires careful engineering around workspace lifecycle, the LSP protocol, and how Roslyn's analysis pipeline works.

## What "Real" Errors Look Like in Roslyn

The [.NET Compiler Platform (Roslyn)](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/) produces two broad categories of diagnostics, each with distinct prefixes and severity behaviors.

**Compiler diagnostics** carry a `CS` prefix for C# and an `FS` prefix for F#. These are the errors and warnings produced by the language compiler itself — type errors, missing members, syntax violations, unreachable code. A `CS0246` means a type name could not be resolved. A `CS0019` means an operator cannot be applied to the operand types. These diagnostics are authoritative: they reflect what the compiler knows about your code after full semantic analysis.

**Roslyn analyzer diagnostics** carry `CA` (code quality) or `IDE` (code style) prefixes and are documented in the [.NET code analysis overview](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/overview). As Microsoft's documentation states:

> "Code analysis violations appear with the prefix 'CA' or 'IDE' to differentiate them from compiler errors."

Analyzer diagnostics are [configurable in severity](https://learn.microsoft.com/en-us/dotnet/fundamentals/code-analysis/overview#enable-additional-rules) — they can be suggestions, warnings, or errors. When a team sets an analyzer rule to `error` severity — via `.editorconfig`, a `<TreatWarningsAsErrors>` property, or a `<AnalysisMode>` configuration — those diagnostics will fail the build. They are not optional noise. They are build-blocking errors. SharpLsp must surface them with the same prominence as `CS` errors, because from the project's perspective they are equivalent.

Third-party analyzer packages — [StyleCop](https://www.nuget.org/packages/StyleCop.Analyzers/), [Roslynator](https://www.nuget.org/packages/Roslynator.Analyzers/), [Meziantou.Analyzer](https://www.nuget.org/packages/Meziantou.Analyzer/), [SonarAnalyzer](https://www.nuget.org/packages/SonarAnalyzer.CSharp/) — slot into the same pipeline. Their diagnostics are processed by Roslyn's `DiagnosticAnalyzer` infrastructure and reported with the same severity model. SharpLsp does not treat these as second-class. If a StyleCop rule is configured as an error in your project, it appears as an error in the Problems panel, because it would appear as an error in your build.

## The Source of False Errors

The enemy of diagnostic accuracy is premature assertion — showing a diagnostic before the workspace has the information needed to compute it correctly.

Large .NET solutions do not become semantically complete all at once. When a solution opens, several things must happen before Roslyn can produce authoritative answers:

1. **NuGet restore must complete.** Roslyn's `MSBuildWorkspace` relies on `project.assets.json` to understand package references and their transitive closure. Before this file is current, type references from NuGet packages cannot be resolved. Any diagnostic computed in this window may report `CS0246` for types that exist in packages — errors that vanish the moment restore finishes.

2. **Source generators must run.** [Source generators](https://learn.microsoft.com/en-us/dotnet/csharp/roslyn-sdk/source-generators-overview) produce C# files at compile time. If the workspace produces diagnostics before generators have executed, references to generated types appear as undefined symbols — another category of errors that are not real.

3. **Project references must resolve.** In a multi-project solution, a project's type graph includes types defined in referenced projects. If Roslyn has not yet loaded a referenced project, cross-project symbol references look unresolved.

The pattern is always the same: a language server that pushes diagnostics eagerly — before the workspace is ready — produces errors that are technically consistent with the incomplete state the workspace is in, but wrong relative to what the compiler would actually report. These are not bugs in the compiler. They are a timing problem: the server asserted too soon.

## The LSP 3.17 Pull Diagnostic Model

SharpLsp's solution to this timing problem is the [LSP 3.17 pull diagnostic model](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_diagnostic).

In the traditional push model, a language server sends `textDocument/publishDiagnostics` notifications whenever it decides diagnostics have changed. The server controls the timing. The editor receives whatever the server sends, whether or not the workspace is in a state to produce accurate results.

The pull model inverts this. The editor asks for diagnostics when it wants them, using two LSP endpoints:

- **`textDocument/diagnostic`** — pulls diagnostics for a specific document
- **`workspace/diagnostic`** — pulls diagnostics for the entire workspace, allowing the editor to surface errors in files that are not currently open

The server responds to each pull with a result that carries a **result identifier** — a token representing the current state of the diagnostic set. If the editor pulls again and the workspace state has not changed, the server can respond with `DocumentDiagnosticReportKind.Unchanged`, skipping redundant computation. This makes repeated pulls cheap for unchanged files in large solutions.

When workspace state does change — a file is saved, a package is restored, a project reference is added — the server sends a `workspace/diagnostic/refresh` notification. This is not a diagnostic payload. It is a signal to the editor that its cached results should be discarded and it should pull again. The editor controls the re-pull timing. The server cannot push stale results.

This design means SharpLsp never has to decide unilaterally "now is a good time to assert diagnostics." It waits for the editor to ask. When asked, it either has a trustworthy answer (workspace is ready) or it says so honestly (workspace is still loading). It never invents errors to fill the gap.

## The NuGet Restore Gate

The most significant source of spurious CS0246 errors in .NET tooling is a stale or missing `project.assets.json` — the restore graph that tells the compiler where to find package assemblies.

Before SharpLsp opens a solution in `MSBuildWorkspace`, it checks restore state. If packages are not restored, it runs `dotnet restore` and waits for completion before beginning workspace load. The diagnostic pipeline does not open until the workspace is in a state where package references can resolve.

This adds latency to the first-open experience — typically a few seconds for a solution that has never been restored in this environment. The tradeoff is that every diagnostic the editor receives after that gate has passed is computed against a workspace that knows its full package graph. There are no CS0246 errors for types that exist in packages. There are no red squiggles that disappear thirty seconds later.

## Solution-Wide Diagnostics

Accurate diagnostics for open files alone is not sufficient. Real build failures often originate in files that are not open in the editor. A breaking change to a shared type causes errors across every file that uses it — most of which may be closed.

SharpLsp uses `workspace/diagnostic` to provide solution-wide error coverage. When the editor requests a workspace diagnostic report, SharpLsp queries Roslyn for diagnostics across all documents in all loaded projects. The result covers:

- All `CS`/`FS` compiler errors in any source file
- All `CA` and `IDE` analyzer diagnostics at `error` or `warning` severity, from both the built-in SDK analyzers and any third-party analyzer packages referenced by the project
- Any diagnostics produced by source generators whose output fails to compile

The result does **not** include:

- Diagnostics computed against an incomplete workspace state
- Analyzer suggestions that are configured below `warning` severity and would not appear in a build
- Errors in files excluded from the project graph

This mirrors what `dotnet build` reports. The Problems panel shows what matters. It does not show noise.

When a file changes, the sidecar computes updated diagnostics for that document and sends a `workspace/diagnostic/refresh`. The editor pulls the updated workspace report. Files whose result identifiers have not changed are skipped by the server — the round-trip cost is proportional to what actually changed.

## F# Diagnostics

The F# sidecar uses [FSharp.Compiler.Service](https://fsharp.github.io/fsharp-compiler-docs/) to produce diagnostics via `FSharpChecker`. FCS diagnostics carry `FS` prefixes and reflect the full F# type checker's view of the project — including discriminated union exhaustiveness, missing interface implementations, unused bindings (`FS0026`), and partial active patterns.

[FSharpLint](https://github.com/fsprojects/FSharpLint) provides the analyzer layer for F#, with configurable rule severity. Lint errors configured as build-blocking are surfaced with the same treatment as Roslyn `CA` errors — they appear in the Problems panel and are not filtered.

F# file ordering in `.fsproj` matters for compilation. FCS will report errors for forward references that occur because files are in the wrong order. SharpLsp surfaces these as real diagnostics — they are real build errors — while flagging the ordering source so developers understand the fix.

## What the Problems Panel Should Tell You

The goal SharpLsp is building toward is a Problems panel you can treat as a build oracle. Before you commit. Before you push. Before CI runs. If the Problems panel is empty, the build passes. If it has errors, the build fails for exactly those reasons.

This requires three things working together:

1. **Accuracy on first display** — the NuGet restore gate ensures the workspace is ready before diagnostics flow
2. **Complete coverage** — workspace diagnostics cover every file, not just open ones, and include all analyzer severities that would fail a build
3. **Accurate invalidation** — `workspace/diagnostic/refresh` keeps the editor in sync with reality as files change, without asserting prematurely

A diagnostics panel that earns trust is one that developers stop second-guessing. That is the target.
