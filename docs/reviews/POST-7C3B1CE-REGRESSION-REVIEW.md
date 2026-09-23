# Remaining release bugs

Updated 2026-09-23 — SharpLspAstra1. Baseline: `7c3b1ce68cd7a4df8b95973b828c80c4335daa2c`.

## P1 — Unresolved debugging races ([#282](https://github.com/Nimblesite/SharpLsp/issues/282), [#260](https://github.com/Nimblesite/SharpLsp/issues/260))

- Windows breakpoint enable test waits for one sync after remove + add, then sees removal state `[100]` instead of enabled state `[100,103]`. Wait for the exact final update; retain the exact-lines and real-stop assertions. [Evidence](https://github.com/Nimblesite/SharpLsp/issues/282#issuecomment-5787156557).
- Linux stepping timeout follows a breakpoint on thread 7500, steps on thread 7461, and adapter exit before the timeout. Investigate workbench focus/step targeting; this is not proof of an adapter-alive terminate hang. [Trace](https://github.com/Nimblesite/SharpLsp/issues/260#issuecomment-5787156319).
- Native netcoredbg terminate/crash race and intermittent Windows attach/pause failure still need a reproduced root-cause fix.

Introduction dates remain unproven. A later green run does not establish these races are fixed.

## P1 — NuGet Update can cross major versions and its test can modify committed projects ([#270](https://github.com/Nimblesite/SharpLsp/issues/270))

- `src/editors/vscode/src/nuget.ts` still executes an unversioned package update. Implement latest stable within the installed major (minor for `0.x`), exact-version confirmation, and explicit opt-in for majors/prereleases. [Implementation plan](../plans/NUGET-UPDATE-PLAN.md).
- `src/editors/vscode/src/test/suite/nuget-deps-e2e.test.ts` still falls back to the first workspace project when its temporary target is absent, then accepts either success or a handled error. Remove the fallback; use disposable C# and F# projects, assert the exact update, and prove committed fixtures remain unchanged.

Both defects predate the release baseline.
