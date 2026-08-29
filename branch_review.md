# Branch review: regressions and test weakening

Compared branch `fixes` with merge base `e96c1027a5a039b59da68d110adba1f9a5bd4dc4` (`origin/main`). Per request, this reviewer ran no CI or test suite; findings are from static review of the production and test diffs.

## PR #199 post-merge addendum

PR #199 was approved and its exact head (`51ea50eb3e0680c11a54ee51265bd6baf44de6ed`) was merged into the current `fixes` branch by merge commit `d8c127a9`. `main` was not checked out, changed, or targeted.

Static review of the merged package-directive implementation found these release-blocking defects before follow-up fixes:

- The synthetic project was hand-built with interpolated XML, including unescaped package input, instead of `ProjectRootElement`.
- Restore used a random directory outside the file-based app's MSBuild configuration cone, ignored the process exit code, and swallowed cleanup failures.
- Restore blocked the initial workspace rather than exposing immediate BCL IntelliSense and upgrading asynchronously.
- Restore failure was silently presented as a successful load; there was no `filebased-degraded` status or informational diagnostic.
- Package generations and degradation state could outlive a reopened root, leak stale references, or destroy a neighboring projectless root during cleanup.
- Concurrent directive generations rewrote the same synthetic project and `obj` artifacts while older restore processes were still running; the original generation fence protected only result application, not the shared build state.
- The first serialization fix opened `.restore.lock` before creating its parent work directory and retried every `IOException`; `DirectoryNotFoundException` therefore became a permanent 50 ms retry loop that prevented every tier-1 upgrade.
- Explicit package versions were emitted as ordinary `Version` metadata even inside a central-package-management cone, producing `NU1008` instead of honoring the file directive as an override.
- The first follow-up made `WorkspaceManager.Dispose()` non-idempotent and a later split temporarily exceeded the repository's 500-line file limit.
- Misplaced `#:package` directives were still collected into the semantic package set, so invalid source could activate a package despite the compiler diagnostic.

The current follow-up replaces those paths with a DOM-built deterministic synthetic project, app-cone evaluation, checked restore output, immediate tier-2 fallback plus generation-safe tier-1 upgrade, explicit `SLSPC0001` degradation, per-root isolation, idempotent disposal, and CST-derived placement rejection. Restore work is serialized per root across processes; the deterministic PID/generation artifact directory is cleaned before the lock is released and may only then be reused by a waiting manager. The lock parent is created before acquisition, and retry is limited to platform contention errors with a hard timeout. Explicit package versions switch between `Version` and `VersionOverride` according to central package management. The plan deliberately leaves unresolved SDK-band/global.json parity and other incomplete file-based-app work unchecked rather than claiming full spec completion.

The VSIX regression blanket now contains 12 real extension-host cases and 127 explicit assertions across `filebased-package-e2e.test.ts`, `filebased-package-config-e2e.test.ts`, and their package test kit. It covers real package hover/completion, live add/remove/re-add, include closure binding, multi-root isolation, final restore failure (not the temporary pending state), exact fallback diagnostic geometry, misplaced directives, package identity swaps, completion edit geometry, central package management, `Directory.Build.props`, and live `#:property` evaluation. Tier transitions are polled by exact package hover text or a compiler-diagnostic generation marker, so temporary BCL output cannot satisfy a tier-1 assertion. Both suites route through the real `sharplsp/loadSolution` request and are registered in the `lsp` Windows chunk.

The C# sidecar blanket adds another 13 real-filesystem `WorkspaceManager` cases and 121 explicit assertion sites. It covers the synthesized DOM and escaped property values, deterministic per-app/per-generation paths, two concurrent managers serializing the same app restore, cleanup, CPM and configuration-cone evaluation, exact package and BCL hover ranges, exact degradation status/message/range, rapid-generation fencing, reopen behavior, live package/include removal and re-addition, multi-root reference and entry-point isolation, and repeat-safe disposal during active restore. These tests invoke real restore/MSBuild/Roslyn paths and use no resolver mocks.

This reviewer initiated no PR #199 VSIX, sidecar, or CI test run. Other agents working concurrently did execute some suites despite the explicit restriction; those runs are not claimed as review verification. Prettier, ESLint, TypeScript `--noEmit`, the chunk-membership checker, C# formatting/build/lint, and `git diff --check` were used as static checks only. Runtime behavior therefore remains intentionally unverified by this review.

## Findings

### 1. High: Explicit launch configurations no longer receive `launchSettings.json` profile values

`src/editors/vscode/src/debug.ts:90-93`

The debug configuration provider now returns immediately whenever the user has supplied `config.program`:

```ts
if (config.request !== 'launch' || config.program !== undefined) {
  return config;
}
```

Before this branch, launch-profile processing happened after program resolution and was applied to every launch request, including configurations with an explicit `program`. As a result, an existing `launch.json` configuration that specifies its executable no longer receives the selected profile's environment variables or command-line arguments.

The new explicit-program test in `src/editors/vscode/src/test/suite/debug-e2e.test.ts:120-155` only verifies that the program and name survive resolution. The launch-profile test starts from an empty F5 configuration, so the regressed combination—explicit `program` plus a launch profile—is no longer protected.

Recommendation: preserve an explicit `program`, but still apply the matching launch profile to launch requests. Add an integration test that supplies both an explicit program and profile data and verifies environment and arguments.

### 2. High: Cancellation no longer prevents remaining selected tests from running, and the cancellation test cannot detect that

`src/editors/vscode/src/testing.ts:304-333`

The previous runner invoked selected tests individually and checked `token.isCancellationRequested` between invocations. Cancelling did not kill the already-running test, but it did prevent the remaining selected tests from starting. The branch batches the entire selection into one `dotnet test` call, checks cancellation only before starting that call, and then awaits it without any cancellation mechanism. `runDotnet` in `src/editors/vscode/src/dotnet-process.ts:79-94` accepts no abort signal and exposes no child-process handle.

Therefore, once the batched `dotnet test` starts, pressing Stop cannot prevent any of the selected tests from running. The batch can continue until its timeout and its results are still reported after cancellation. The lost behavior is the prior runner's cancellation boundary between selected tests.

The replacement cancellation test in `src/editors/vscode/src/test/suite/test-explorer-outcomes.test.ts:851-935` is vacuous for this failure mode: it reruns one failing and one skipped test, cancels at 0 ms, and asserts only that neither becomes passed. A completely uncancelled execution produces those same failing/skipped states, so the test passes even when cancellation is ignored.

Recommendation: make `runDotnet` abortable, terminate the spawned process on cancellation, suppress results received after cancellation, and test with a deliberately long-running test whose process termination and cancelled state are observable.

### 3. High: Moving netcoredbg in-process loses adapter-crash handling and can strand debug sessions

`src/editors/vscode/src/debug.ts:353-373`, `src/editors/vscode/src/dap-router.ts:103-121`, `src/editors/vscode/src/dap-router.ts:271-283`

Before this branch, the factory returned `DebugAdapterExecutable`, leaving process lifecycle and protocol-failure handling to VS Code. It now launches netcoredbg itself and returns `DebugAdapterInlineImplementation` around `DapRouter`.

The router's child `exit` and `error` handlers only log/set local state. They do not emit a DAP `terminated` event, reject or settle pending requests, dispose the inline adapter, or otherwise tell VS Code that the adapter died. An unexpected netcoredbg crash or startup failure can therefore leave the debug session alive but permanently unresponsive.

The inline parser also calls `JSON.parse` on adapter output without a guard. Malformed adapter output now throws from extension-host code instead of being contained at the executable-adapter boundary.

The new lifecycle coverage exercises normal debuggee termination, not netcoredbg startup failure, unexpected adapter exit, truncated frames, or malformed JSON.

Recommendation: convert child startup/error/exit and parser failures into a deterministic session termination, settle all pending requests, and add focused tests for adapter death and malformed/truncated protocol frames.

### 4. Medium: Build-command regression test was replaced with assertions that are always true

`src/editors/vscode/src/test/suite/fsi-build-output-e2e.test.ts:244-252`

The build commands were refactored from terminals to VS Code tasks, but the replacement test does not verify that any task starts:

```ts
const started = await pollUntilResult(
  async () => vscode.tasks.taskExecutions.map((execution) => execution.task.name),
  (running) => running.length >= 0,
  5_000,
);
assert.ok(Array.isArray(started));
```

`running.length >= 0` is unconditionally true, and `map(...)` unconditionally returns an array. The test succeeds when all three commands are no-ops. The node-scoped variant likewise checks that commands do not reject and that no old-style terminal appears, but never verifies task dispatch or command arguments.

This weakens the old test's concrete side-effect assertion without replacing it with the equivalent Task API assertion, leaving regressions in build, rebuild, clean, and node-scoped dispatch undetectable.

Recommendation: subscribe to `vscode.tasks.onDidStartTaskProcess` (or compare task executions before/after), then assert that each command starts exactly one expected task with the correct project, target, and arguments.

## Scope note

This report intentionally omits incomplete future features and defects confined to newly introduced functionality. The findings above are limited to existing behavior that regressed and tests that were weakened or made incapable of detecting the claimed behavior.
