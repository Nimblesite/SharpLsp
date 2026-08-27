# Branch review: regressions and test weakening

Compared branch `fixes` with merge base `e96c1027a5a039b59da68d110adba1f9a5bd4dc4` (`origin/main`). Per request, no CI or test suite was run; findings are from static review of the production and test diffs.

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
