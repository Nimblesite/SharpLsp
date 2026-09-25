---
layout: layouts/blog.njk
title: "SharpLsp 0.19.0: A Run, Debug, and Test Loop You Can Trust"
description: "SharpLsp 0.19.0 root-causes the VS Code run/debug experience — launch profile discovery, the multi-profile prompt, cancellable builds — adds logical async call stacks via a new DapRouter, and hardens the Test Explorer with 4,800 lines of end-to-end tests."
date: 2026-08-30
author: SharpLsp Team
image: /assets/images/blog/sharplsp-0-19-run-debug-test-explorer.png
imageAlt: An abstract SharpLsp language-service graph connecting C# braces, F# syntax, project files, packages, and diagnostics
tags:
  - posts
  - announcement
  - csharp
  - fsharp
  - dotnet-lsp
category: announcement
excerpt: "0.19.0 fixes the inner loop for real: F5 and launch profiles that behave like dotnet run, async stacks that read like your code instead of MoveNext soup, and a Test Explorer backed by 4,800 lines of end-to-end tests."
---

Version 0.19.0 is about the inner loop: press F5, pick a launch profile, hit a breakpoint, read the stack, run the tests. That whole loop now works — and, more importantly, we can prove it works, because every piece of it is covered by end-to-end tests that build real projects and assert real outcomes.

The release ships VSIX packages for all five platforms — win32-x64/arm64, linux-x64/arm64, and darwin-arm64 — with SHA256 checksums on the [release page](https://github.com/Nimblesite/SharpLsp/releases/tag/v0.19.0). Here's what changed.

## F5 and Launch Profiles, Fixed for Real

The previous run/debug experience had bugs that no amount of UI polish could hide: profiles that `dotnet run` could see but the extension couldn't, silent failures when a project had more than one profile, and a build step that couldn't be cancelled. We root-caused all three.

- **Launch profile discovery.** The extension now resolves launch profiles through the same MSBuild evaluation that `dotnet run` uses, including cases where `TargetPath` evaluation previously hid valid profiles. If `dotnet run --launch-profile X` starts your app, F5 with profile X starts it too.
- **The multi-profile prompt.** Projects with more than one launch profile now prompt you to choose, instead of silently picking one — or failing to start at all.
- **Cancellable builds.** `applyTarget` now kicks off a real build and honors cancel. Previously it was effectively fire-and-forget, which meant the debugger could race a build that was still emitting binaries.

The run/debug end-to-end chunk is 21/21 green. These suites launch actual project files, attach, and verify behavior — they don't mock the debugger.

## Async Stacks That Read Like Your Code

Debugging async C# has always meant squinting at state-machine internals: a wall of `MoveNext` frames instead of the `await` chain you actually wrote. This release introduces the **DapRouter** (`dap-router.ts` + `dap-frames.ts`), a routing layer for the Debug Adapter Protocol that **reconstructs the logical async call stack** before anything reaches the editor.

With the router in place, pausing inside an awaited call shows the chain you'd expect:

```
ProcessOrders()
  await ChargeCardAsync()
    await Gateway.PostAsync()   ← paused here
```

...not three tiers of compiler-generated plumbing.

The DapRouter speaks DAP 1.71 and is also the groundwork for what comes next: netcoredbg and the ICorDebug path become interchangeable behind it, and features on the roadmap — logpoints, `DebuggerDisplay` emulation, hot reload coordination — build on the same plumbing.

## A Test Explorer Backed by End-to-End Proof

Test explorers rot quietly: discovery works on the demo project, then fails on yours. Version 0.19.0 adds **seven new end-to-end suites — roughly 4,800 lines of tests** — covering:

- **Frameworks** — discovery and execution across the supported test frameworks
- **Outcomes** — passed, failed, and skipped results reported accurately
- **Parsers** — test output parsed into real outcomes, not just text
- **Reactivity** — the tree updates as results arrive
- **Windows** — behavior on the platform that behaves differently
- **Kit** — the helpers the other suites are built on

The outcome assertions check what actually ran, not just what rendered. And the behavior is now specified in `TEST-EXPLORER-SPEC.md`, so it's documented contract rather than folklore.

## Editor Extensions That Can't Quietly Rot

The most valuable fix in this release might be the one you'll never see. During the 0.19.0 cycle we discovered that SharpLsp's own Zed extension shipped test suites that were never executed — some of which were tautologies asserting that constants equal themselves. Green pipelines containing nothing. That is the exact failure mode that produces releases like the ones this post is about, so we fixed it structurally:

- **Zed**: 31/31 tests passing, with 85.04% line coverage now gated in CI. The tautological tests are gone, the version-parity test actually parses `extension.toml`, and the pipeline logic is extracted into `pipeline.rs` where it can be tested directly.
- **Rider**: the Kotlin plugin — 2,961 lines that previously had *zero tests and zero CI presence* — now has its first eight tests (NuGet state merging, case-insensitive package-ID matching, sort order, pending flags) and is compiled on every PR via the new `ci-editors.yml` pipeline.
- **No silent emptiness**: `failOnNoDiscoveredTests = true` across the editor legs, so a test task that discovers nothing can never report success again.

## Build and Release Hardening

The remaining work is invisible plumbing that keeps the release itself honest:

- A **VSIX payload verifier** (`verify-vsix-payload.mjs`) checks that what gets published is what we built — no missing sidecars, no stale artifacts.
- A **netcoredbg fetch fix** keeps debugger binaries resolving reliably during builds.
- The Rust host picked up a `semantic_tokens` clippy fix, and the website gained a Mermaid render test.
- The full .NET suite — 983 tests — passed in CI for this release.

## Getting 0.19.0

Install from the [release page](https://github.com/Nimblesite/SharpLsp/releases/tag/v0.19.0) (VSIX for your platform, with SHA256 checksums), read the [docs](https://sharplsp.dev/docs/), and if something in the inner loop breaks on your project — [that's exactly the issue we want](https://github.com/Nimblesite/SharpLsp/issues).
