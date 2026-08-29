---
layout: layouts/blog.njk
title: "SharpLsp 0.19.0: What .NET Developers Search For, and the Run/Debug/Test Fixes That Answer It"
description: "Google Trends shows developers searching for a C# language server, F# tooling, and alternatives to OmniSharp and C# Dev Kit. SharpLsp 0.19.0 answers with root-caused run/debug fixes, async stack reconstruction, and a hardened Test Explorer."
date: 2026-08-30
author: SharpLsp Team
image: /assets/images/blog/sharplsp-0-19-run-debug-test-explorer.png
imageAlt: Search trend lines for C# and F# tooling queries feeding into a debugger and test explorer
tags:
  - posts
  - announcement
  - csharp
  - fsharp
  - dotnet-lsp
category: announcement
excerpt: "The searches tell the story: 'c# language server' is climbing, OmniSharp interest is fading, and F# editor queries barely register. SharpLsp 0.19.0 ships the fixes those searches are asking for — working F5 and launch profiles, logical async debugging, and a Test Explorer you can trust."
---

Every .NET developer has run one of these searches: *"c# vscode"*, *"c# language server"*, *"F# vscode"*, *"neovim c#"*. They are the queries you type when you want the full .NET experience — build, run, debug, tests — in the editor you already chose, without switching to a proprietary IDE.

Before shipping 0.19.0, we looked at what that demand actually looks like on Google Trends, then aimed the release squarely at it. This post covers both: what the search data says, and what SharpLsp 0.19.0 does about it.

## What the Search Data Says

We pulled interest data from Google Trends (worldwide, web search, trailing 12 months) for the queries that lead developers to a tool like SharpLsp. Three comparisons tell the story. One caveat first: Trends normalizes each comparison to its own peak, so the numbers are comparable *within* a chart, not across charts — the direction and shape are what matter.

### 1. "C# Dev Kit" dominates; OmniSharp is fading

Comparing **OmniSharp**, **C# Dev Kit**, and **"F# vscode"** over the past 12 months:

| Query | 12-month average | Direction |
|---|---|---|
| C# Dev Kit | 46 | Climbing — weekly interest in the 50s–70s through spring 2026 |
| OmniSharp | 24 | Sagging — down to 5–14 by late August 2026 |
| F# vscode | ~0 | Flatline |

Two things stand out. First, the demand for C# Dev Kit is real and growing — developers want that caliber of experience. Second, the open-source name that used to own this space is losing search share, and C# Dev Kit is closed-source and VS Code-only. Developers searching for it are increasingly asking a question it can't answer: *what if I want this in Zed, Neovim, Emacs, or Rider?*

### 2. "c# language server" is the fastest-rising query in this space

Comparing **"c# language server"**, **"F# language server"**, and **"dotnet lsp"**:

| Query | 12-month average | Direction |
|---|---|---|
| c# language server | 33 | Strongly rising — sporadic spikes of 34–50 in late 2025, then sustained 48–100 from February 2026, peaking at the chart maximum the week of June 14, 2026 |
| F# language server | 0 | Flatline |
| dotnet lsp | 0 | Just registering — its first non-zero readings (7, then 5) came in the final two weeks of the window |

This is the most interesting chart. The framing of the search itself is changing: developers aren't searching for an *extension* anymore, they're searching for a *language server* — a signal that editor-agnostic .NET tooling is becoming the mental model. And **"dotnet lsp" appearing at all, for the first time in the last two weeks of the window, is exactly what an emerging category looks like** on Trends before it goes mainstream.

### 3. F# demand exists — but it's fragmented and suppressed

Comparing **OmniSharp**, **"c# language server"**, and **ionide**:

| Query | 12-month average | Notes |
|---|---|---|
| OmniSharp | 56 | The incumbent search term in this comparison |
| c# language server | 20 | Rising on a relative basis too |
| ionide | 4 | Spiked to 32 the week of July 19, 2026 |

The F# picture is the quiet scandal of .NET tooling. "F# vscode" and "F# language server" flatline at effectively zero. Ionide — heroic, community-built, and years ahead of anything vendor-provided — still only averages 4 against OmniSharp's 56 in the same comparison. Some of that is a smaller community. But a language where Microsoft's own strategy document admitted the tooling "doesn't quite measure up" teaches its users to stop searching. Suppressed demand is still demand. F# developers want completions, go-to-definition, debugging, and test runs just like everyone else — they've just been trained not to expect them.

That's why SharpLsp treats F# as a first-class citizen, not a checkbox: both languages run through the same architecture, get features at the same time, and are held to the same test bar.

## What Those Searches Are Actually Asking For

Read the intent behind the queries and it converges on one thing: **the complete inner loop — edit, build, run, debug, test — in any editor, without proprietary lock-in.**

That's precisely where open-source .NET tooling has historically fallen over. Completions and hover got good years ago. What broke was everything after the code compiles: F5 that doesn't start, launch profiles that don't appear, async stack traces that look like `MoveNext` soup, a Test Explorer that shows tests that aren't there.

Version 0.19.0 is aimed directly at that gap.

## SharpLsp 0.19.0: Run, Debug, Test

[SharpLsp 0.19.0](https://github.com/Nimblesite/SharpLsp/releases/tag/v0.19.0) ships VSIX packages for all five platforms — win32-x64/arm64, linux-x64/arm64, and darwin-arm64, with SHA256 checksums. The theme of the release is trust in the inner loop.

### F5 and launch profiles, root-caused

The VS Code run/debug experience had real bugs, and this release root-caused them rather than papering over symptoms:

- **Launch profile discovery** — profiles that MSBuild's `TargetPath` evaluation hid from the extension are now found and surfaced. If `dotnet run` can start your app with a profile, F5 can too.
- **The multi-profile prompt** — projects with more than one launch profile now correctly prompt you to choose, instead of silently picking (or failing).
- **`applyTarget` now builds and honors cancel** — selecting a run target kicks off a real build you can actually cancel, instead of a fire-and-forget that raced the debugger.

The run/debug end-to-end chunk is 21/21 green — verified against real project files, not mocks.

### Debugging async code like a debugger should

This release introduces the **DapRouter** (`dap-router.ts` + `dap-frames.ts`), a proper routing layer for the Debug Adapter Protocol that also **reconstructs logical async call stacks**. Instead of the physical stack — a wall of `MoveNext` frames from the compiler-generated state machines — you see the logical `await` chain: the code you wrote, in the order you wrote it.

Async stack reconstruction is one of the features the debugging spec calls out as missing from upstream netcoredbg, and it's a genuine community pain point. Getting it working through the router is also what lets SharpLsp treat netcoredbg and the ICorDebug path as interchangeable backends — protocol plumbing that later phases (logpoints, `DebuggerDisplay` emulation, hot reload coordination) build on.

### A Test Explorer you can trust

Test explorers rot quietly: discovery works on the demo project, then fails on yours. 0.19.0 adds seven new end-to-end suites — roughly 4,800 lines of tests — covering frameworks, outcomes, parsers, reactivity, Windows behavior, and the test kit, plus outcome assertions that check what actually ran, not just what rendered. This work is now specified in `TEST-EXPLORER-SPEC.md`, so the behavior is documented contract, not folklore.

### Editor coverage that can't quietly rot

The other PR in this release found that SharpLsp's own Zed extension shipped 23 tests that were never executed — several of which were tautologies asserting that constants equal themselves. That's the failure mode Trends can't show you: green pipelines containing nothing.

0.19.0 fixes that class of problem structurally:

- **Zed**: 31/31 tests passing, 85.04% line coverage gated in CI — and the version-parity test now actually parses `extension.toml`.
- **Rider**: the Kotlin plugin — 2,961 lines that previously had *zero tests and zero CI presence* — now has its first 8 tests (NuGet state merging, case-insensitive package-ID matching, sort order, pending flags) and is compiled on every PR. `failOnNoDiscoveredTests = true` means an empty test task can never report success again.
- A new `ci-editors.yml` pipeline runs both editor legs on every PR, and a VSIX payload verifier (`verify-vsix-payload.mjs`) checks that what we publish is what we built.

Alongside these, the .NET suite passed 983 tests in CI, and a netcoredbg fetch fix keeps debugger binaries resolving reliably during builds.

## The Point

The search trends and the release notes are telling the same story from two sides. Developers are searching for **"c# language server"** at record rates because they want .NET everywhere they work — not because they want another extension locked to one editor. F# developers search less because they've been burned more. And the moment they try an open-source tool, the first thing that has to work is the inner loop: run, debug, test.

That's what 0.19.0 delivers. Not features for a changelog — root-caused fixes for the workflows the searches are about.

SharpLsp is MIT-licensed, built on Roslyn and FSharp.Compiler.Service, with a Rust host doing the protocol work. If you've been typing any of the queries in this post into a search bar, [try the release](https://github.com/Nimblesite/SharpLsp/releases/tag/v0.19.0), read the [docs](https://sharplsp.dev/docs/), and if you hit a bug that a search engine sent you chasing — [that's exactly the issue we want](https://github.com/Nimblesite/SharpLsp/issues).
