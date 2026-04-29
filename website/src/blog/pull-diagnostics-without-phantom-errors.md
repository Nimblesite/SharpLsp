---
layout: layouts/blog.njk
title: "Pull Diagnostics Without Phantom Errors"
description: "SharpLsp uses LSP 3.17 pull diagnostics and workspace refresh so C# errors converge with Roslyn state instead of pushing stale false positives during solution load."
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
excerpt: "Diagnostics are only useful if developers can trust them. SharpLsp's diagnostic design starts there."
---

Diagnostics are the developer feedback loop. If the Problems panel lies, people stop trusting it. SharpLsp's diagnostic architecture is built around that constraint: report what the compiler knows, invalidate aggressively when the workspace changes, and avoid pretending a half-loaded solution is complete.

SharpLsp implements diagnostics around the [LSP 3.17 diagnostic model](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_diagnostic): editors pull diagnostic reports, and the server sends workspace refresh notifications when cached results should be discarded.

## Why Push Diagnostics Are Risky During Load

Large .NET solutions do not become semantically complete all at once. A workspace may still be restoring NuGet packages. Source generators may not have produced output. Project references may still be resolving. Roslyn may have enough state to parse a file but not enough state to give the final semantic answer for the solution.

If a language server pushes diagnostics too early, users can see false `CS0246` or `CS0234` errors for types that resolve correctly once the workspace finishes loading. The editor did not fail. The server asserted too soon.

SharpLsp avoids that failure mode. It does not need to proactively claim that every file has errors at a specific instant during workspace load.

## The Pull + Refresh Loop

SharpLsp's intended diagnostic flow is:

1. The editor opens a solution or document.
2. The Rust LSP host tracks document state and routes semantic requests to the sidecar.
3. The C# sidecar uses Roslyn workspace state to answer document or workspace diagnostic pulls.
4. Each result carries identity based on project, document, and global workspace state.
5. When workspace state changes, the sidecar notifies the host.
6. The host sends `workspace/diagnostic/refresh`.
7. The editor pulls again under the new state.

That gives the editor a cacheable protocol without stale authority. The server can say "unchanged" when the result identity still matches, and it can force a re-pull when solution state moves.

## The NuGet Restore Gate

NuGet restore is one of the biggest sources of phantom diagnostics in .NET tooling. Missing assets can make perfectly valid code look broken. SharpLsp's diagnostic spec treats restore state as part of correctness, not a background convenience.

Before creating the Roslyn workspace for a solution, SharpLsp's design includes a restore gate for stale `project.assets.json` state. The goal is not to hide real compiler errors. The goal is to prevent diagnostics from being computed against a workspace that cannot possibly know its package references yet.

## Solution-Wide Diagnostics Still Matter

Avoiding false positives does not mean limiting diagnostics to open files. SharpLsp is designed for solution-wide diagnostics because build breaks usually cross file and project boundaries.

The important distinction is timing and invalidation:

- Open-file diagnostics answer what the editor asks for directly.
- Workspace diagnostics let the editor surface errors outside currently open documents.
- Refresh notifications tell the editor when previous answers should no longer be trusted.

This is more disciplined than a one-shot eager scan. It is also friendlier to large solutions because unchanged result identities let the editor and server skip repeated work.

## What Users Should Expect in the Alpha

SharpLsp is still alpha software. The VS Code extension is the main proving ground, and the diagnostics path is being tightened around real Roslyn behavior, not mock project graphs.

The target is straightforward: when SharpLsp shows a C# diagnostic, it should reflect Roslyn's current understanding of the workspace. When Roslyn's understanding changes, SharpLsp should make the editor ask again. That is how a .NET LSP earns trust.
