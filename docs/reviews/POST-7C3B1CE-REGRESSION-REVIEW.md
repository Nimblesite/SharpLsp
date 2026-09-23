# Remaining release bugs found in the post-release review

Reviewed 2026-09-23 by SharpLspAstra1.

Baseline: `7c3b1ce68cd7a4df8b95973b828c80c4335daa2c`.
Reviewed **main**: `133be8b1e0b9cd5adfe5032b161e2b852eeaf300` (includes PRs #291 and #296).
Only defects still present in this commit are listed. **Not ready for release.**
Classification: one regression of existing SDK/sidecar-host selection and two bugs in newly added MTP functionality. The two MTP findings are not demonstrated regressions of behavior supported by the release baseline.

## P1 — SDK selection can disable both C# and F# language services

Tracked in [#297](https://github.com/Nimblesite/SharpLsp/issues/297) — **regression**.

[dotnetRuntime.ts:90–96](https://github.com/Nimblesite/SharpLsp/blob/133be8b1e0b9cd5adfe5032b161e2b852eeaf300/src/editors/vscode/src/dotnetRuntime.ts#L90-L96) selects another installation solely because its SDK satisfies `global.json`. It does not check that the installation can run SharpLsp's **net10.0** sidecars. The selected root is also passed to the LSP as `DOTNET_ROOT`. The install path similarly requests only the workspace's pinned version at line 212.

**Reproduced:** a workspace pins SDK `9.0.312`; the Install Tool supplies a working .NET 10 host, and a separate root contains SDK `9.0.312` / runtime `9.0.14`. Acquisition returns the .NET 9-only root as success, with no warning. Its `dotnet --version` succeeds, but both actual C# and F# sidecar DLLs exit **150**, requesting `Microsoft.NETCore.App 10.0.0`. Build compatibility has displaced the runtime required for completions, diagnostics and navigation.

**Introduced:** alternate-root selection in `289f48a7` (#275); pin-only acquisition in `c26eec40` (#268). The release baseline always requested a .NET 10-or-newer SDK.

**Required fix/test:** separate the workspace build SDK from the sidecar host, or validate both requirements before accepting a root. Cover an older pinned SDK in a separate installation and fresh acquisition. `sdk-pin.test.ts` currently creates empty fake executables and SDK directories; it cannot detect a host that cannot launch either sidecar.

## P1 — MTP runs an old DLL after an output-path change and reports false green

Tracked in [#298](https://github.com/Nimblesite/SharpLsp/issues/298) — **new-feature bug**.

[test-mtp-run.ts:406–411](https://github.com/Nimblesite/SharpLsp/blob/133be8b1e0b9cd5adfe5032b161e2b852eeaf300/src/editors/vscode/src/test-mtp-run.ts#L406-L411) rebuilds the target but keeps the discovery-time module paths. Relisting refreshes UIDs from that **same old DLL**, not from MSBuild's new `TargetPath`.

**Reproduced separately in real C# and F# xUnit MTP projects:** discover and run a passing test; change `OutputPath` to `bin/Changed/` and change the assertion from `3 == 1 + 2` to `4 == 1 + 2`; run using the existing discovery plan. The build succeeds, the old DLL remains under `bin/Debug/`, and SharpLsp reports **passed**. Fresh discovery points to `bin/Changed/` and the identical selected test reports **failed: Expected 4, Actual 3**.

**Introduced:** MTP execution in `870867dc` (#262), after the release baseline. This is a defect in newly added MTP support, not evidence of previously supported MTP behavior regressing.

**Required fix/test:** resolve the current module set after rebuilding, before UID relisting/execution. Add C# and F# tests that change the output path between discovery and Run without refreshing first, retain the obsolete binary, and require the edited failure. Existing edited-source/data-row tests keep the output path unchanged.

## P2 — Removing every MTP test leaves stale tests and results in the explorer

Tracked in [#299](https://github.com/Nimblesite/SharpLsp/issues/299) — **new-feature bug**.

[test-mtp-discovery.ts:219](https://github.com/Nimblesite/SharpLsp/blob/133be8b1e0b9cd5adfe5032b161e2b852eeaf300/src/editors/vscode/src/test-mtp-discovery.ts#L219) returns `ok: false` whenever modules exist but contain no tests, even when their JSON listing is valid. `listModule` also treats xUnit's no-tests exit code 8 as a discovery failure. The controller consequently preserves the previous tree and cached results instead of pruning removed tests.

**Reproduced in both C# and F#:** remove all test methods from a previously discovered, still-buildable MTP project. The module emits `{"schemaVersion":1,"tests":[]}`, but `listMtpTests` returns `ok: false` and a code-8 warning. [testing.ts:277–283](https://github.com/Nimblesite/SharpLsp/blob/133be8b1e0b9cd5adfe5032b161e2b852eeaf300/src/editors/vscode/src/testing.ts#L277-L283) then retains the old entries; a newly opened empty project instead gets a misleading discovery-error row.

**Introduced:** MTP discovery in `870867dc` (#262), after the release baseline. This is a defect in newly added MTP support, not evidence of previously supported MTP behavior regressing.

**Required fix/test:** distinguish a valid empty listing from a refused, killed or malformed listing. For both languages, discover and run tests, remove the last test, refresh, and assert an empty tree and pruned result cache. Keep the existing failure-preservation assertions; a parser-only `tests: []` check does not cover this decision.

## Verification scope

The reproductions ran on macOS arm64 against freshly bundled **main source** and real temporary .NET projects. PR #296 landed during review; its additional changes were inspected, and the affected selection/execution/discovery code is unchanged. SDK selection used a stubbed VS Code Install Tool response but real installed SDK/runtime files and real sidecar processes. Explorer retention was traced through the controller; a full VS Code UI run and Linux/Windows reruns were not performed for this review.

Local reproduction scripts and logs: `/tmp/sharplsp-main-regression.j1m0Oc/` (`repro.mjs`, `repro.log`, `sdk-repro.mjs`, `sdk-repro.log`). No product code or existing tests were changed.
