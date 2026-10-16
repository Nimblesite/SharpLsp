---
layout: layouts/blog.njk
title: ".NET Framework on Windows, in VS Code: run and test net48 next to net10.0, in C# and F#"
description: "On Windows, SharpLsp builds, runs and tests .NET Framework 4.6.2–4.8.1 code on the desktop CLR, in C# and F#, from VS Code, Cursor and Windsurf, next to the modern .NET builds of the same project. What works, what doesn't yet, and why it matters."
date: 2026-10-14
author: SharpLsp Team
image: /assets/images/blog/dotnet-framework-windows-vs-code.png
imageAlt: An emerald ribbon connects a stone window and a modern green arch, representing .NET Framework and modern .NET working together
tags:
  - posts
  - csharp
  - fsharp
  - testing
  - dotnet-lsp
category: engineering
excerpt: "A lot of the .NET that ships every day is .NET Framework 4.8, on Windows. SharpLsp edits it on every OS, and on Windows it also runs and tests it, next to the net10.0 build of the same project."
---

The .NET that gets the conference talks is `net10.0`. A lot of the .NET that ships every day is `net48`: the line-of-business app, the WCF service, the WinForms tool the finance team can't do without, the library with one important customer still on 4.6.2. It runs on Windows, it isn't going away, and it is often the reason a team's editor was chosen for them.

[Since 0.23](/blog/dotnet-framework-multi-targeting-csharp-fsharp/), SharpLsp has analysed .NET Framework code on every OS. On Windows it does the rest of the job too: it **builds, runs and tests that code on the real desktop CLR**, in C# and F#, from the editor you already use.

## Why this matters

- **.NET Framework isn't end-of-life.** There will be no .NET Framework 5, but 4.8.1 ships as part of Windows and is serviced with it. Code that targets it will be maintained for years.
- **Migrations happen in the middle.** Nobody ports a large codebase in one step. Projects multi-target `net48;net8.0` and move one at a time, so the same file compiles for both runtimes for months, often years. An editor that serves only one of them serves half the migration.
- **Old code needs the most help from its tools.** Navigating code nobody remembers writing, finding every reference before a delete, running the tests before every change: that is the daily work in a fifteen-year-old codebase.

For many teams, the .NET Framework projects are the last reason everyone has to use the same IDE. They don't have to be.

## What works on Windows

| | What SharpLsp does | Where |
| --- | --- | --- |
| **Edit** | Completions, navigation, diagnostics and refactoring inside `#if NETFRAMEWORK` code, against the 4.x reference assemblies | every OS |
| **Build** | `dotnet build`, with reference assemblies the SDK pulls from NuGet. No targeting packs to install | every OS |
| **Run** | Ctrl+F5 runs a multi-targeted project's `net48` build on the desktop CLR | Windows |
| **Test** | VSTest and MTP discover and run every framework, with one result per framework | Windows |
| **Debug** | Refused with a reason; debug the .NET build of the same code | — |

All of it covers `net462` through `net481`. The in-place 4.8.x runtime in current Windows 10 and 11 runs every one of them.

## Run: Ctrl+F5 on the desktop CLR

In a multi-targeted project, pick `net48` in the status bar, then press **Ctrl+F5**. SharpLsp starts the task `Run <Project> (net48)`:

```text
dotnet run --project <proj> --framework net48
```

There is no debug adapter in the way, so the build starts on the CLR it was compiled for. The framework comes from the status bar when you launch from one of the project's files, and otherwise it is the first one the project declares. Either way the output channel logs `Run: <Project> under net48`.

## Test: every framework, one tree

A multi-targeted test project appears once in the Test Explorer, with its frameworks on the row: `net48 · net10.0`.

- **Each test is tagged** `tfm:net48`, `tfm:net10.0` for every framework that lists it. A test that exists only under `#if NET48` appears only there.
- **Each result knows its framework.** The merged outcome is the worst one, and a failure carries one message per failing framework, prefixed `[net48]`. "Fails only on .NET Framework" is visible at a glance.
- **Run on `net48`** is its own run profile. It builds, then runs `dotnet vstest` on that framework's assemblies only. It never runs `dotnet test --framework net48`, which fails with NETSDK1005 on every project in the solution that doesn't target `net48`.

## MTP on .NET Framework: an .exe, not a .dll

A Microsoft.Testing.Platform module for .NET is a `.dll` that `dotnet exec` hosts. For .NET Framework, MSBuild produces a real `<Name>.exe`, and `dotnet exec` can't host the desktop CLR, so SharpLsp starts the `.exe` directly. It is tested with MSTest in C# and xUnit v3 in F#, each on `net48` beside .NET.

## F#, on the same terms

None of this is C#-only. An F# project's `net48` options come from MSBuild's own design-time compile: `--targetprofile:mscorlib`, the 4.8 reference assemblies and the `NETFRAMEWORK;NET48` defines. F# test projects run on `net48` under VSTest and MTP, and **Ctrl+F5** runs an F# program on the desktop CLR exactly as it runs a C# one.

## What it doesn't do yet: debug the desktop CLR

SharpLsp ships netcoredbg, an open-source debugger for .NET. It doesn't attach to the .NET Framework desktop CLR, and a test host waiting for a debugger that never arrives just hangs. So SharpLsp doesn't let that happen:

- **Debug** on tests runs the selection's .NET frameworks. A .NET Framework-only selection is refused at once, with a message that says why.
- **F5** on a multi-targeted program debugs its .NET framework.

During a migration that is usually enough: debug on `net10.0`, run and test on `net48`.

## Built on Windows, tested on Windows

- **Windows-only CI.** Four VS Code test chunks run only on Windows runners, through the real extension: the language services over .NET Framework projects, the Test Explorer, and three real repositories at pinned commits ([GitReader](https://github.com/kekyo/GitReader), [CsvHelper](https://github.com/JoshClose/CsvHelper) and [NLog](https://github.com/NLog/NLog)).
- **Native builds** for Windows x64 and Arm64. The sidecars talk to the host over named pipes.
- **The small things.** Since 0.25, a `.cmd` or `.bat` shim on `PATH` can no longer stand in front of the bundled sidecars ([#167](https://github.com/Nimblesite/SharpLsp/issues/167)). Windows is a platform we test on, not one we port to.

## Try it

1. Install **SharpLsp 0.25** or later from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=nimblesite.sharplsp) or [Open VSX](https://open-vsx.org/extension/nimblesite/sharplsp), in VS Code, Cursor, Windsurf or VSCodium.
2. Open a solution with an SDK-style project that targets a .NET Framework version and a .NET one, for example `net48;net10.0`. You need the .NET 10 SDK and nothing else: no targeting packs, no IDE install.
3. Pick `net48` in the status bar, press **Ctrl+F5**, and open the Test Explorer.

The whole stack is MIT licensed: no account, no seat count, nothing to renew. If your .NET Framework project doesn't behave, [open an issue](https://github.com/Nimblesite/SharpLsp/issues). Real project files from real migrations are exactly what we want to see.
