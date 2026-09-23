# [DIST-SPEC] Distribution Specification

This is the normative specification for SharpLsp distribution.

## [DIST-CI-AUDIT] Dependency Vulnerability Gate

`make audit` MUST scan both Cargo lockfiles (host and Zed), the sidecar NuGet solution including transitive packages, and both npm lockfiles (VS Code and website) against current advisory databases. Rust vulnerability findings fail the gate; NuGet and npm fail at moderate or higher by default, including every high/critical finding. Lower-severity findings remain visible. Scanner or restore failures MUST fail, not count as a clean result.

CI and tagged releases MUST call the same reusable `ci-audit.yml` workflow. The final CI job MUST include `audit` in its dependencies and fail on its failure/cancellation. GitHub Release creation MUST depend on a successful audit of the tagged revision, and Marketplace/Open VSX publishing MUST depend on that release. No `continue-on-error` or publish bypass is permitted. New advisories require a fresh release-time scan even when the PR previously passed.

Known vulnerabilities MUST be resolved by upgrading affected direct/transitive dependencies and testing compatibility, not by weakening thresholds or suppressing findings. A clean advisory scan is evidence about the scanned dependency inventory, not a guarantee that all bundled native binaries or runtime installations are vulnerability-free.

Regression guards: `tools/audit/dotnet-vulnerable.test.mjs` tests real vulnerable and clean NuGet reports; `tools/ci/security-gates.test.mjs` parses workflow YAML and verifies CI/release dependency enforcement. Both MUST run in CI.

## [DIST-CI-CLASSIFICATION] Fail-Closed Change Detection

The PR workflow MUST successfully retrieve every page of changed files before deciding which checks can skip. An API error, including failure after partial output, or an empty response MUST fail `detect-changes` without publishing classification outputs. The terminal `CI` job MUST depend on every upstream job and fail on any failure or cancellation. The active main-branch ruleset MUST require this exact GitHub Actions check with no bypass actors; build/test failures and pending checks cannot be merged.

Product tests MUST run on pull requests only, not on a push or merge to main. `tools/ci/changed-files.test.mjs` executes the workflow's actual Bash classifier, covering failed, partial, empty, docs-only, code and manifest responses, and guards the terminal dependency list and PR-only trigger. It MUST run through `make _lint-vsix` in CI.

## [DIST-CI-VSIX-SHARDS] VS Code Suite Shards

One runner, `make _test-vsix-shard CHUNK=<name>`, drives every slice of the VS Code end-to-end suite on every platform, always instrumented for coverage. The chunks are declared once, in `src/editors/vscode/test-chunks.json`, and the Ubuntu and Windows matrices both expand from it. Every shard uploads its extension-host logs (`vsix-logs-<platform>-<chunk>`) on every outcome, with the DAP trace enabled, so a green shard carries the evidence of WHICH path passed it — a fallback that fired leaves its line in those logs and nowhere else.

### [DIST-CI-VSIX-SHARDS-TIMEOUTS] Test Timeout Tiers

Every wait in the suite is a poll for the STATE the next step needs, never a count of events and never a fixed sleep, and every poll takes its budget from one tier in `src/editors/vscode/src/test/suite/test-timeouts.ts`. A test that needs longer names the slow process it waits on, in a comment, at the site.

The one exception is a NEGATIVE assertion — that a stop never came, that a process was not killed, that the host never signalled itself. A state that must never arrive cannot be waited for, so a fixed quiet period (`QUIET_MS`) followed by the assertion is the correct structure there; the assertion fails if the forbidden thing happens inside the window, and the only judgement is whether the window is long enough. The test for a wait is therefore: does the assertion after it say something HAPPENED (poll for the state) or that something DIDN'T (quiet period)?

The invariant: a poll's budget plus the work that precedes it MUST sit strictly below the ceiling of the test or hook it runs in. When the two are equal the runner kills the test first and reports its own generic timeout, which names nothing, in place of the poll's report, which names what never held and the last value it saw. Exhausting a poll budget FAILS; it never returns the last value.

| Tier | Budget | Used for |
|------|--------|----------|
| `FAST_MS` | 1 s | Pure in-process work: no IPC, no editor round trip |
| `COMMAND_MS` | 5 s | One command round trip through the extension host, never reaching a sidecar |
| `SETTLE_MS` | 10 s | Workbench or OS settling; a healthy run never spends it |
| `LSP_RESPONSE_MS` (`DEFAULT_TEST_MS`) | 15 s | One request to a warm language server; the ceiling a test inherits when it declares none |
| `PROCESS_START_MS`, `SETTINGS_WRITE_MS` | 30 s | Starting a debuggee to attach to; a settings write propagating back through the extension host |
| `DEBUG_SESSION_MS` | 45 s | One debug gesture: launch, stop, step, stop-session |
| `DEBUG_TEST_MS` | 50 s | The ceiling of a test built on one `DEBUG_SESSION_MS` wait |
| `ACTIVATION_MS`, `LSP_SWEEP_MS` | 60 s | Extension activation (hooks only); a sweep of sidecar round trips scaling with the fixture |
| `READINESS_MS` | `ACTIVATION_MS − SETTLE_MS` | The readiness poll inside `setupLspTestSuite`, under the `ACTIVATION_MS` hook that calls it |
| `SIDECAR_COLD_MS` | 90 s | The first semantic request against a freshly opened project |
| `DOTNET_CLI_MS`, `SERVER_RESTART_MS` | 120 s | A `dotnet` CLI call; a server restart followed by its cold request |
| `FIXTURE_BUILD_MS` | 240 s | `dotnet build` of a test fixture |
| `REAL_REPO_MS`, `REAL_REPO_WARMUP_MS` | 600 s, 480 s | A real repository loaded end to end; its warm-up poll, under the hook that contains it |
| `WHOLE_RUN_MS` | 20 min | The runner's ceiling for one shard; MUST stay below the job's `timeout-minutes` so a hang still gets a mocha report |

## [DIST-COMPONENTS] Required Components

SharpLsp has three executable components. All three are REQUIRED and MUST be bundled in the VSIX. Missing any one of them puts activation into degraded mode with a user-facing error notification (see [DIST-FAILURE-UX]).

| Component ID | Binary | Required | Distribution |
|---|---|---|---|
| `sharplsp` | `sharplsp` / `sharplsp.exe` | **YES** | Bundled in per-platform VSIX: `bin/<platform>/sharplsp[.exe]` |
| `sharplsp-sidecar-csharp` | `sharplsp-sidecar-csharp` | **YES** | Bundled in every VSIX: `bin/all/sharplsp-sidecar-csharp` |
| `sharplsp-sidecar-fsharp` | `sharplsp-sidecar-fsharp` | **YES** | Bundled in every VSIX: `bin/all/sharplsp-sidecar-fsharp` |

All three are verified by Shipwright on every VS Code activation via `activationVerifies` in `shipwright.json`.

## [DIST-DEBUGGER-BUNDLE] Debugger Bundle

Debugging uses **netcoredbg**, the managed-code DAP adapter launched for the `sharplsp-coreclr` debug type by `SharpLspDebugAdapterFactory` in `src/editors/vscode/src/debug.ts`. It is bundled in the VSIX.

| Aspect | Requirement |
|---|---|
| Source | `Samsung/netcoredbg`, pinned to `3.2.0-1092` / commit `9744e1f051866215611b8440c638042aa2aa2f72`, MIT-licensed; `tools/netcoredbg/dap-hot-reload.patch` exposes the existing debugger-side delta applier over DAP, and `tools/netcoredbg/exception-stepping.patch` lets a step start from a frame without symbols. Upstream mixes CRLF and LF sources while this repo stores patches LF, so the patches MUST be applied with `core.autocrlf=input` (line-ending-normalised), never under the runner's own git config |
| Staging | `tools/vsix/build-netcoredbg.sh <platform>` builds the pinned source and CoreCLR headers, then `tools/vsix/fetch-netcoredbg.sh <platform>` stages the result into `bin/<platform>/netcoredbg/`; both Makefile staging paths use it. An adapter counts as current only when its `.sharplsp-dap-hot-reload` marker names the lock's build (`netcoredbgCommit:patchVersion`), so a build from an older lock is provided and staged again, never shipped |
| Layout | `bin/<platform>/netcoredbg/netcoredbg[.exe]` **plus** its sibling managed assemblies (`ManagedPart.dll`, `dbgshim.dll`, `Microsoft.CodeAnalysis*.dll`) — the whole directory ships, since the executable loads them |
| Resolution | `getNetcoredbgCandidates(extensionPath)` prefers the bundled binary; scan order is user-setting (`sharplsp.debug.netcoredbgPath`) → **bundled** → common install paths → `PATH` |
| Platform coverage | SharpLsp source-builds `win32-x64`, `linux-x64`, `linux-arm64`, and `darwin-arm64` on matching native runners. On `win32-arm64` and `darwin-x64`, debugging falls back to a `PATH` copy / the setting. The staging script skips those platforms cleanly (exit 0). |

Unlike the three [DIST-COMPONENTS], a missing netcoredbg degrades **only** the debugging feature (surfaced via an error toast pointing at the install), not whole-extension activation.

**Licensing.** netcoredbg (MIT, © 2017 Samsung Electronics Co., LTD) and every other bundled third-party component are acknowledged in [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md); all bundled licenses are permissive and compatible with SharpLsp's MIT license. Bumping the pinned netcoredbg or CoreCLR commit MUST update `tools/vsix/build-netcoredbg.sh`, its patch, and the notices file in lockstep.

## [DIST-RUNTIME-ACQUIRE] .NET SDK Acquisition

The framework-dependent `net10.0` sidecars require a .NET 10 SDK, not merely a runtime. The C# sidecar performs an in-process MSBuild design-time build and `MSBuildLocator.QueryVisualStudioInstances(options)` enumerates installed SDKs; a runtime-only or older-SDK machine cannot provide matching MSBuild/Roslyn and project load fails with `FUSION_E_REF_DEF_MISMATCH` or no MSBuild. SharpLsp therefore acquires the SDK through Microsoft's [`ms-dotnettools.vscode-dotnet-runtime`](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.vscode-dotnet-runtime) extension. See `src/sidecars/SharpLsp.Sidecar.CSharp/MSBuildInstanceSelector.cs` and [DIST-SDK-DISCOVERY].

> The .NET Install Tool exposes `dotnet.acquire` for a local runtime, `dotnet.acquireGlobalSDK` for a system-wide SDK, and `dotnet.findPath` for discovery. Its API contract is documented at <https://github.com/dotnet/vscode-dotnet-runtime/blob/main/Documentation/commands.md>.

**Hard rules:**

1. SharpLsp's [src/editors/vscode/package.json](../../src/editors/vscode/package.json) MUST declare `"extensionDependencies": ["ms-dotnettools.vscode-dotnet-runtime"]`. VS Code installs declared dependencies silently when SharpLsp is installed — no user prompt.
2. SharpLsp MUST explicitly activate the .NET Install Tool extension (`vscode.extensions.getExtension(...).activate()`) before invoking its commands. `extensionDependencies` activates it first, but the explicit await turns a missing/disabled dependency into a clear `[DIST-FAILURE-UX]` message instead of an opaque "command `dotnet.findPath` not found".
3. On every activation SharpLsp MUST call the `dotnet.acquireGlobalSDK` command exposed by the .NET Install Tool with the parameter shape mandated in [DIST-API-PARAMETERS]. The command returns `{ dotnetPath: string }` pointing at the `dotnet` executable of a system-wide SDK install. A global SDK install runs the platform installer and **may prompt for elevation** — that UI belongs to the .NET Install Tool, and is the unavoidable cost of providing MSBuild; SharpLsp never shows the elevation prompt itself.
4. Before `dotnet.acquireGlobalSDK`, SharpLsp MUST call `dotnet.findPath` with `mode: 'sdk'` and `versionSpecRequirement: 'greater_than_or_equal'` to skip acquisition when the user already has a compatible SDK (>= 10.0). The path returned by either call is the SDK SharpLsp uses.
5. **"Compatible" MUST be judged against the workspace `global.json`, not merely `>= 10.0`.** `greater_than_or_equal` on `10.0` is satisfied by *any* 10.0.x SDK, including a feature band the workspace pin forbids — `10.0.203` (band 200) against a `10.0.303` (band 300) pin under the default `latestPatch`. Accepting it makes SharpLsp report success while every subsequent `dotnet` invocation — builds, tests, and the C# sidecar's `hostfxr_resolve_sdk2` — fails with exit code 155. SharpLsp MUST therefore read the nearest `global.json` at or above the workspace root, evaluate the installed SDKs beside the returned `dotnetPath` against its `version`/`rollForward`, and treat an unsatisfiable result as "not found" so acquisition proceeds. `rollForward` defaults to `latestPatch` when a `version` is present.
6. When the workspace pins an SDK, `dotnet.acquireGlobalSDK` MUST request that **exact pinned version** rather than the `10.0` band, so the install actually satisfies the pin instead of landing in a band `global.json` rejects.
7. An unsatisfiable pin MUST be surfaced per [DIST-FAILURE-UX] naming the pinned version, the `rollForward` policy, the `global.json` that set it, and the SDKs actually installed. `dotnet` writes those facts to the build task's terminal, which the task's `close: true` presentation disposes on exit, leaving the user only VS Code's generic `failed to launch (exit code: 155)`.

**Implementation reference:**
- `src/editors/vscode/src/global-json.ts` — pin discovery (`readSdkPin`), `rollForward` evaluation (`sdkSatisfiesPin`), installed-SDK enumeration.
- `src/editors/vscode/src/dotnetRuntime.ts` — `existingSdkSatisfiesWorkspace`, `describeSdkPinFailure`, pin-aware `tryFindExistingSdk` / `callAcquireSdk`.
- `src/editors/vscode/src/build.ts` — `diagnoseBuildFailure` turns a non-zero build exit into the pin diagnosis.
- `src/editors/vscode/src/test/suite/sdk-pin.test.ts` — regression suite.
8. SharpLsp MUST set `DOTNET_ROOT` (the directory of `dotnetPath`) on the environment passed to the Rust LSP host so all spawned sidecars run on that SDK's runtime and so `MSBuildLocator` finds that SDK's MSBuild.

**UX during acquisition — inform, never ask (SharpLsp's own UI):**

- A non-interactive progress notification MUST appear: `vscode.window.withProgress({ location: vscode.window.ProgressLocation.Notification, title: 'SharpLsp: Installing .NET 10 SDK', cancellable: false }, ...)`.
- The `SharpLspStatusBar` MUST indicate the acquisition is in flight.
- SharpLsp's own UI shows no buttons or modals requiring action. (The OS elevation prompt raised by a global SDK installer is the .NET Install Tool's UI, not SharpLsp's.)

**Failure path:** Surface per [DIST-FAILURE-UX]. The notification MUST name the .NET 10 **SDK** in plain language. Activation enters a degraded state and registers a `SharpLsp: Retry .NET acquisition` command. Activation MUST NOT crash the extension host or block other extensions.

Shipwright continues to verify sidecar startup via `verifyStartup: true`. With `DOTNET_ROOT` pointed at the SDK, the apphost finds the runtime, MSBuild loads, and the version probe succeeds.

## [DIST-SDK-DISCOVERY] Workspace-Independent SDK Discovery

The C# sidecar enumerates installed SDKs to pick the one whose Roslyn matches its bundled `Microsoft.CodeAnalysis` ([DIST-RUNTIME-ACQUIRE]). That enumeration MUST be **independent of the opened workspace**. MSBuildLocator resolves an SDK from a *working directory* via `hostfxr_resolve_sdk2`, which honours any `global.json` at or above that directory. The sidecar process inherits the workspace root as its working directory, so a naïve `MSBuildLocator.QueryVisualStudioInstances()` resolves the *workspace's* `global.json`. When that file pins a `version`/`rollForward` band with no installed match (e.g. Fantomas pins `10.0.100` on a box that has only `10.0.203`), `hostfxr_resolve_sdk2` throws `InvalidOperationException` ("A compatible .NET SDK was not found").

Discovery failure before the `READY:` handshake can cause an endless sidecar restart loop and block MSBuild-free requests such as `solution/read`, including for pure-F# solutions. It MUST therefore follow the degraded path below (issue #134).

**Hard rules:**

1. **SDK discovery MUST NOT consult the opened workspace.** Query with an explicit `VisualStudioInstanceQueryOptions { DiscoveryTypes = DiscoveryType.DotNetSdk, WorkingDirectory = <neutral> }` where `<neutral>` is a directory guaranteed to have no `global.json` in its ancestry (a dedicated scratch directory under the temp root — *not* `AppContext.BaseDirectory`, which during development sits under the repo's own `global.json`). This enumerates every installed SDK regardless of the workspace pin, so the Roslyn-matching one can still be selected. Note `new VisualStudioInstanceQueryOptions()` defaults `DiscoveryTypes` to `None` (0) in Microsoft.Build.Locator 1.11.x — it MUST be set explicitly or discovery returns nothing.
2. **`MSBuildLocator.RegisterDefaults()` MUST NOT be used.** It re-queries with the process working directory (the workspace) and re-triggers the same crash. Register a chosen instance by path instead — the Roslyn match, or the newest installed SDK as a fallback.
3. **Discovery MUST span every .NET root on the machine, not just the resolved one.** `QueryVisualStudioInstances` enumerates the SDKs of a SINGLE root — the one hostfxr picks from `DOTNET_ROOT` or the running host. Two roots is the ordinary state of a dev machine (a `dotnet-install.sh` copy in `~/.dotnet` beside an installer or Homebrew copy in `/usr/local/share/dotnet`), and they hold different SDKs. When the resolved root is not the one holding the Roslyn-matching SDK, selection never sees it, registers the newest SDK of the *wrong* root, and every project load fails with `FUSION_E_REF_DEF_MISMATCH` — the failure rule 1 exists to prevent (issue #295). The queried instances MUST therefore be unioned with a scan of `<root>/sdk/<version>` across `DOTNET_ROOT`, the `dotnet` muxer on `PATH`, and the per-user and machine-wide install locations, keyed by path so hostfxr's own answer wins any tie. A prerelease directory (`10.0.100-preview.1.25080.5`) MUST still be read — `Version.Parse` rejects it outright, and dropping it reintroduces the blindness the scan removes. An unreadable root MUST contribute nothing rather than throw.

   A CI runner installs exactly one root, so **no CI leg can observe this defect**. It MUST therefore be asserted over a synthetic two-root layout in unit tests, not left to an environment CI never has.

4. **SDK-registration failure MUST degrade, never crash.** Neither discovery nor registration may take the sidecar down: on any failure it logs one actionable hint and leaves MSBuild unregistered. The process MUST still reach `READY` and serve MSBuild-free requests (`solution/read`, `ping`, `shutdown`). Roslyn-backed handlers then fail per-request with a clear error rather than the whole sidecar crash-looping. This is a specialization of [DIST-FAILURE-UX] for the sidecar process.

The one-shot startup hint emitted on the degraded path is a sanctioned sidecar stderr write per [DIST-CLEAN-OUTPUT] (alongside the Roslyn-mismatch hint) — it is actionable, level-appropriate, and fires at most once per process, never per request.

**Implementation reference:**
- `src/sidecars/SharpLsp.Sidecar.CSharp/MSBuildInstanceSelector.cs` — `QueryInstalledSdks` (explicit `DiscoveryType.DotNetSdk` + neutral `WorkingDirectory`), `DiscoverSdkCandidates` / `CandidateDotnetRoots` / `SdkCandidatesUnder` (the multi-root union of rule 3), `NewestPath` fallback, `BuildDiscoveryFailedHint`; `Register` no longer calls `RegisterDefaults()`. An SDK found only by the scan has no `VisualStudioInstance`, so it registers through `RegisterMSBuildPath`.
- `src/sidecars/SharpLsp.Sidecar.CSharp.Tests/MSBuildInstanceSelectorTests.cs` — `Discovery_sees_an_sdk_that_lives_only_in_a_second_dotnet_root` builds two throwaway roots and asserts the SDK in the unresolved one is still discovered; `Repo_pinned_sdk_ships_exactly_the_bundled_roslyn` resolves the `global.json` pin against the same surface the product uses.
- `src/sidecars/SharpLsp.Sidecar.CSharp/Program.cs` — MSBuild registration failure logs and continues instead of `Environment.Exit(1)`.
- `src/sidecars/SharpLsp.Sidecar.CSharp.Tests/GlobalJsonSdkPinEndToEndTests.cs` — spawns the real sidecar apphost with a workspace whose `global.json` pins an uninstalled SDK and asserts it reaches `READY` and serves `solution/read`.

## [DIST-API-PARAMETERS] .NET Install Tool Parameters

Every call SharpLsp makes to the .NET Install Tool MUST include all four required fields in the `IDotnetAcquireContext`:

```ts
{
  version: '10.0',                     // major.minor band, OR the exact version global.json pins
  mode: 'sdk',                         // 'runtime' | 'sdk' | 'aspnetcore' — SharpLsp needs 'sdk' for MSBuild
  architecture: dotnetArchitecture(),  // 'x64' | 'arm64' | 'x86' — derived from process.arch
  requestingExtensionId: 'nimblesite.sharplsp',
  installType: 'global',               // required by dotnet.acquireGlobalSDK; omit for dotnet.findPath
}
```

`dotnet.findPath` takes the same four required fields nested under `acquireContext` (no `installType`), plus `versionSpecRequirement: 'greater_than_or_equal'`. `dotnet.acquireGlobalSDK` takes them flat, plus `installType: 'global'`.

`dotnet.findPath` MUST use the `10.0` band — it is a discovery probe, and the pin is applied to its answer per [DIST-RUNTIME-ACQUIRE] rule 5. `dotnet.acquireGlobalSDK` MUST use the pinned version when the workspace declares one (rule 6); a global SDK install accepts a fully-qualified version.

`architecture` is derived from Node's `process.arch` and mapped as: `x64` → `x64`, `arm64` → `arm64`, `ia32` → `x86`, default → `x64`. This mapping lives in `src/editors/vscode/src/dotnetRuntime.ts`.

The .NET Install Tool rejects a `dotnet.findPath` payload missing `mode`, `version`, `architecture`, or `requestingExtensionId`; `acquireContext` MUST contain all four fields. See the upstream contract at <https://github.com/dotnet/vscode-dotnet-runtime/blob/main/Documentation/commands.md>.

## [DIST-FAILURE-UX] Activation Failure UX

Whenever activation cannot deliver a working language server — for any reason, at any step — SharpLsp MUST inform the user with a non-modal notification.  The extension MUST NEVER fail silently and MUST NEVER throw out of `activate()`.

**Hard rules:**

1. **`activate()` MUST always resolve, never reject.** Any error caught at the top level results in a non-modal error notification + degraded return value, never a re-throw. VS Code logs uncaught activation rejections to its own developer console where users do not see them — that is exactly the failure mode this rule prevents.
2. **Every non-trivial helper invoked from activation MUST return `Result<T, E>`** (from `src/editors/vscode/src/result.ts`). Helpers MUST NOT use `throw` for expected error paths. The only `throw` in the codebase is the one VS Code itself produces when an extension dependency is missing — and even that is caught and surfaced.
3. **Every failure surfaces a non-modal `vscode.window.showErrorMessage(…)`** with at minimum a `[Show Log]` button that calls `log.output().show()`. Where applicable, additional informational links MAY be added (`[Open dot.net]`, `[Retry]`, `[Reinstall]`). Buttons are convenience links, never required actions.
4. **The status bar MUST move to `ServerState.Error`** so the persistent indicator reflects the degraded state.
5. **The error message MUST name the failure mode in plain language** ("required binaries are missing or version-mismatched", ".NET 10 install failed", "language server crashed during startup") — never just dump a stack trace into the toast. The full diagnostic text goes to the output channel reachable via `[Show Log]`.
6. **Recovery commands MUST be registered** so the user can re-attempt without uninstalling. Examples: `sharplsp.retryDotnetAcquisition`, `sharplsp.restartServer`. These appear in the command palette under the `SharpLsp:` category. `sharplsp.restartServer` MUST start a fresh server even when the old one does not answer `shutdown` in time — a hung server is exactly when a user reaches for it. A restarted server MUST serve the documents the user already has open: a request about an open document waits until the CURRENT server has been sent its `didOpen`. A `didOpen` that failed to send, or that reached the server the restart replaced, does not count (`open-sync.ts`).

**Implementation reference:**
- `src/editors/vscode/src/result.ts` — `Result<T, E>`, `ok`, `err`.
- `src/editors/vscode/src/extension.ts` — outer `activate()` catch surfaces the toast; inner `activateInner()` step paths return early with toast + degraded API instead of throwing.
- `src/editors/vscode/src/dotnetRuntime.ts` — `acquireDotnet10Sdk` returns `Result<string, string>`; the caller pattern-matches.

## [DIST-CLEAN-OUTPUT] Clean Output

Editors capture the language server's `stderr` into a user-facing Output panel (VS Code: the **SharpLsp** channel). Because the Rust host inherits each sidecar's `stderr`, that single stream carries host logs *and* both sidecars' logs. The panel MUST therefore stay clean, human-readable, and level-appropriate — never a dumping ground for raw, colorized, or per-request diagnostics.

**Hard rules:**

1. **No ANSI escape codes reach the panel.** The captured stream is a pipe, not a TTY, so color/cursor escapes render as garbage. The Rust host gates its `tracing` stderr layer on `std::io::IsTerminal` (`.with_ansi(stderr_is_terminal)`), emitting plain text whenever stderr is not an interactive terminal. The VS Code extension additionally strips ANSI defensively before anything reaches the channel (`createAnsiStrippingChannel`).
2. **Sidecars MUST NOT write routine diagnostics to `Console.Error` / `eprintfn`.** Per the project logging rule, sidecar diagnostics use structured logging (Serilog) routed to a per-sidecar rolling file under the system temp directory (`sharplsp-logs/sidecar-<name>.log`)—never the inherited stderr. The only legitimate sidecar `stdout`/`stderr` writes are the versioned `READY:` IPC handshake, the `--version` banner, the CLI usage message, one sanitized pre-READY `FATAL:` diagnostic required by [SIDECAR-STARTUP-FAILURE](SIDECAR-LIFECYCLE-SPEC.md), and the one-shot actionable SDK-resolution hints ([DIST-RUNTIME-ACQUIRE] portability, below, and [DIST-SDK-DISCOVERY])—the Roslyn-mismatch, missing-SDK, and unresolvable-`global.json` startup diagnostics, each emitted at most once per process.
3. **Per-request chatter goes to the file log, not the panel.** Routine traces (e.g. the router's per-request `[Router] Handling …`) are logged at `Debug` to the rolling file. Genuinely user-facing failures still surface (via the host's `error!` on a failed sidecar request, or a `[Show Log]` action per [DIST-FAILURE-UX]).
4. **A type-load failure is summarized once.** MSBuild surfaces a `ReflectionTypeLoadException` as a diagnostic carrying dozens of identical "Could not load file or assembly" lines, repeated once per project. Repeated lines MUST be collapsed (`SidecarLog.CollapseRepeatedLines`) and duplicate summaries de-duplicated so the log records one distinct, actionable line — not a flood.
5. **A line is shown at the level the host wrote it.** The host's `tracing` stderr layer writes every level to the one stream (`<timestamp> <LEVEL> <target>: <message>`), and `vscode-languageclient`'s default `stdioOptions` files every stderr line under `error` — so the channel's level column carried no information and a leg's 1850 `[error]` lines held no error. The extension MUST read the level token off each line and write the remainder at that level (`serverStdioOptions`), dropping the timestamp and level the channel renders itself. A line with no level token (a panic, a backtrace frame, a sidecar `FATAL:`) is shown as written, at `error`: an unclassifiable stderr line is never made quieter than it arrived. A blank line is not shown.

**Implementation reference:**
- `src/sharplsp/src/main.rs` — `IsTerminal`-gated `.with_ansi(…)` on the stderr `tracing` layer.
- `src/editors/vscode/src/output-filter.ts` — `stripAnsi` + `createAnsiStrippingChannel`, wired into the client's `outputChannel` in `src/editors/vscode/src/client.ts`.
- `src/editors/vscode/src/server-stderr.ts` — `classifyServerLine` + `serverStdioOptions`, wired into the client's `stdioOptions` in `src/editors/vscode/src/client.ts`; observed end to end by `src/editors/vscode/src/test/suite/server-stderr.test.ts` through the channel's log file at the extension API's `logUri`.
- `src/sidecars/SharpLsp.Sidecar.Common/Logging/SidecarLog.cs` — Serilog rolling-file configuration + `CollapseRepeatedLines`; initialized by `SidecarHost`.
- `src/sidecars/SharpLsp.Sidecar.CSharp/Workspace/WorkspaceManager.cs` — `LogWorkspaceFailure` collapses and de-duplicates MSBuild workspace-load diagnostics.

## [DIST-VSIX-MODEL] VSIX Distribution Model

The VSIX is self-contained. A user who installs the extension gets everything they need with zero additional installation steps beyond the .NET 10 SDK (which is acquired automatically per [DIST-RUNTIME-ACQUIRE]).

- `sharplsp` — native Rust binary, pre-built per platform, bundled at `bin/<platform>/`
- `sharplsp-sidecar-csharp` — framework-dependent .NET assembly, bundled at `bin/all/`
- `sharplsp-sidecar-fsharp` — framework-dependent .NET assembly, bundled at `bin/all/`

**No component is ever installed via `dotnet tool install`, package manager, or any mechanism outside the VSIX.** The `dotnet-tool` source type is NOT used for VSIX distribution.

## [DIST-VSIX-REBUILD] Mandatory Clean Rebuild Before Packaging and Tests

### [DIST-CI-ARTIFACT-TESTS] Build Once, Then Test the Cached Artifacts

PR CI has an enforced handoff: **check/analyse/build → artifact-only tests**.
Security and analysis gates complete before builds; all test jobs wait for the
build workflow and download immutable artifacts from that same run/commit.

- Each platform/target builds once. C#/F# sidecars and their tests compile in
  Release together; publishing and testing use `--no-build --no-restore`.
- Rust/Zed Release test binaries are built into nextest archives before fan-out.
  Test jobs execute those archives with zero retries; they never compile them.
- Rider builds its plugin and test classes before handoff. Test execution excludes
  Java/Kotlin compilation, and a task-graph guard rejects new compiler dependencies.
- VS Code tests execute the production JavaScript and native payload extracted
  from the packaged VSIX, not a separately built development extension. Its matching
  source map is a private test artifact and never ships inside the VSIX. Coverage
  excludes vendor code after remapping, without lowering the existing ratchet.
- Static test fixtures and coverage utilities are precompiled. Consumers may
  restore NuGet metadata to rebase machine-local package paths, but not compile.
  A feature test which deliberately builds/edits a user's fixture project still
  exercises that operation; this is not permission to rebuild the LSP or harness.
- Each suite has exactly one shard owner per platform. Platform coverage remains
  intentional (Linux and Windows are distinct environments); shared executable
  suites, automatic retries and full-suite reruns after sharding are forbidden.
- Missing artifacts, mismatched package metadata, compilation attempts, failed
  tests and failed coverage gates fail CI. Test execution remains PR-only.

The default local/release entry points below still produce clean native binaries.
An enclosing fresh build passes the prebuilt flag into npm's packaging lifecycle
so that lifecycle cannot secretly rebuild the payload a second time.

Every supported VSIX package and test entry point MUST rebuild its complete payload from clean compiler output by default. A successful incremental build, a cached binary, or a previous test run is not proof of freshness.

The ONE exception is a consumer handed native output built by the same CI run from the same commit, which it declares by setting `VSIX_PREBUILT` (and `VSIX_SUITE_PREBUILT` for the compiled suite). Such output is not the stale incremental tree this section exists to refuse, and rebuilding it per shard would multiply the host, both sidecars and the debugger by the matrix width — hours added to every pull request ([DIST-CI-VSIX-SHARDS]). A prebuilt consumer MUST still stage and verify the payload; it MUST NOT skip staging. Release packaging ignores the flag: a tag never ships a binary its own run did not compile.

1. Delete Rust objects for the selected profile/target before rebuilding the host. Delete generated `bin`/`obj` for all sidecar projects and both publish directories before publishing C# and F#. This includes Roslyn's BuildHost and transitive assemblies, not merely the apphost executable.
2. Rebuild the patched netcoredbg native binary and its managed helper from clean CMake/MSBuild output on every supported debugger platform. Existing build-ID markers do not bypass this. Platforms explicitly without a bundled debugger retain their documented fallback.
3. Run the Roslyn/pinned-SDK compatibility regression before staging. Failures in clean, build, compatibility verification, copy, or package verification MUST stop the consumer; never fall back to an old output tree.
4. Stage only after all builds succeed, into an empty VSIX `bin` tree. Recompile the extension/test JavaScript before its consumer. Verify the production payload before packaging.
5. `_build-vsix`, `_package-vsix` and every platform wrapper, `_test-vsix`, `_test-vsix-shard`, `_run-vsix-suite`, and `_verify-vsix-payload` MUST enforce this automatically. Prebuilt flags are only for the same-run handoff above, not stale local outputs. `npm test`, `npm run test:run`, and `vscode:prepublish` MUST enforce the same default and same-run exception.
6. Clean/build/stage/consume steps MUST run in order. Parallel builds in the same checkout must not overwrite a payload while it is packaged or tested. A filesystem race is a failure, never a passing verification.

Regression coverage: `tools/make/vsix-rebuild.test.mjs` exercises the actual expanded Make recipes, including prebuilt flags and all six release platforms. `tools/vsix/rebuild-contract.test.mjs` verifies npm lifecycle hooks and removal of real stale BuildHost files while preserving sources. Both run in `_test-tooling`; workflow wiring is also checked by `tools/ci/security-gates.test.mjs` in `_lint-vsix`.

## [DIST-VSIX-LAYOUT] VSIX Layout

A separate VSIX is published for each platform. Every VSIX contains all three components:

```
bin/
  <platform>/
    sharplsp          (Unix)
    sharplsp.exe      (Windows)
  all/
    sharplsp-sidecar-csharp
    sharplsp-sidecar-fsharp
```

| Platform VSIX | LSP binary path | C# sidecar path | F# sidecar path |
|---|---|---|---|
| `darwin-arm64` | `bin/darwin-arm64/sharplsp` | `bin/all/sharplsp-sidecar-csharp` | `bin/all/sharplsp-sidecar-fsharp` |
| `darwin-x64` | `bin/darwin-x64/sharplsp` | `bin/all/sharplsp-sidecar-csharp` | `bin/all/sharplsp-sidecar-fsharp` |
| `linux-x64` | `bin/linux-x64/sharplsp` | `bin/all/sharplsp-sidecar-csharp` | `bin/all/sharplsp-sidecar-fsharp` |
| `linux-arm64` | `bin/linux-arm64/sharplsp` | `bin/all/sharplsp-sidecar-csharp` | `bin/all/sharplsp-sidecar-fsharp` |
| `win32-x64` | `bin/win32-x64/sharplsp.exe` | `bin/all/sharplsp-sidecar-csharp` | `bin/all/sharplsp-sidecar-fsharp` |
| `win32-arm64` | `bin/win32-arm64/sharplsp.exe` | `bin/all/sharplsp-sidecar-csharp` | `bin/all/sharplsp-sidecar-fsharp` |

The sidecar binaries are identical across all platform VSIXs — they are managed assemblies and require no platform-specific build.

## [DIST-VSIX-CONTENTS] VSIX Payload Verification

[DIST-VSIX-LAYOUT] says where the payload goes. This says that it is actually there, and that nothing else is.

Every staging step in the Makefile ends in `2>/dev/null || true`, so a stage that half-ran is indistinguishable from one that worked. Without a check, the first report of a missing payload is a user whose extension fails to activate, or a Windows CI chunk that spends forty minutes producing a wall of LSP timeouts whose cause is one absent file.

1. A VSIX MUST NOT be produced unless it carries every entry below for the platform it targets. Each is fatal on its own:

   | Entry | Consequence if absent |
   |---|---|
   | `bin/<platform>/sharplsp[.exe]` | the LSP host — nothing activates |
   | `bin/all/sharplsp-sidecar-csharp[.exe]` | C# has no semantics |
   | `bin/all/sharplsp-sidecar-fsharp[.exe]` | F# has no semantics |
   | `bin/all/SharpLsp.Sidecar.CSharp.dll` | the Roslyn sidecar's managed half |
   | `bin/all/SharpLsp.Sidecar.FSharp.dll` | the FCS sidecar's managed half |
   | `dist/extension.js` | the bundle the manifest's `main` points at |
   | `bin/<platform>/netcoredbg/netcoredbg[.exe]` | F5 fails with a spawn ENOENT |
   | `bin/<platform>/netcoredbg/ManagedPart.dll` | the launcher alone cannot debug |

   The two netcoredbg entries are REQUIRED except on the platforms [DIST-DEBUGGER-BUNDLE] names as having no upstream prebuilt, where they MUST be absent rather than stubbed. A stub that spawns and fails is worse than a missing file, because it defers the error to the user's first F5.

2. A VSIX MUST NOT contain any of the following. Each is a packaging leak, not a harmless extra:

   | Forbidden | Why |
   |---|---|
   | `__MACOSX/` | AppleDouble resource forks from a macOS archive |
   | `src/` | TypeScript sources; the bundle already carries them |
   | `out/` | the compiled test tree |
   | `test-fixtures/` | test fixtures, tens of megabytes of them |
   | `*.map` | source maps |

3. The verification MUST read the file list `vsce` itself will write (`vsce ls`), not the working tree. A check that walks `bin/` proves a staging step ran; it does not prove the result survived `.vscodeignore`, which is the failure this exists to catch.

4. The verification MUST run BEFORE packaging, while the staged `bin/` is still on disk, and its failure MUST stop the build. Verifying afterwards means a broken VSIX already exists and can be installed by anything that does not re-check.

5. The platform MUST be overridable (`SHARPLSP_VSIX_PLATFORM`) so a cross-platform package can be verified for the platform it targets rather than the one building it.

6. `tools/vsix/verify-vsix-payload.mjs` implements this. Both the release packaging path and the local install loop of [DIST-VSIX-DEV-INSTALL] MUST gate on it — a dev loop that installs an unverified VSIX reintroduces exactly the failure this section exists to prevent, one machine at a time.

## [DIST-VSIX-ASSET-INTEGRITY] VSIX Asset Integrity

The extension's icon assets in `src/editors/vscode/icons/` are symlinks into `docs/designs/logo/`. With `core.symlinks=false`, Git materializes target paths as text files, which `vsce` would package as broken icons.

1. Every image asset referenced by the extension manifest MUST be packaged as real image content. A VSIX containing symlink text stubs is broken.
2. `tools/vsix/resolve-symlink-stubs.mjs` rewrites stub files in place with their target's content. It MUST leave real OS symlinks untouched (macOS/Linux, and Windows checkouts with `core.symlinks=true`), making it a cross-platform no-op wherever symlinks work. It only rewrites plain files whose entire content is a relative POSIX path resolving to an existing file.
3. The resolver MUST run automatically before packaging (`vscode:prepublish`) and before the e2e suite (`pretest`), so both the packaged VSIX and the extension-development host load real images. The e2e suite asserts the invariant (`bundled-binary.test.ts`).
4. Resolved stubs modify the working tree and MUST NOT be committed — Git would record the binary content as the symlink's target text, corrupting the symlink for every other platform. Restore with `git restore src/editors/vscode/icons`.

## [DIST-VSIX-DEV-INSTALL] Local Install Loop

Building the VSIX is not installing it. A developer changing the Rust host, either
sidecar or the extension needs one command that puts the result into their own VS
Code, and it MUST be a **full** cycle — stale servers killed, every artifact
cleaned, all three components rebuilt for the host platform, the extension
uninstalled first, the fresh VSIX packaged and installed.

Anything less silently tests the previous build: a running `sharplsp` holds the
binary open (fatally so on Windows), a partial `bin/` stage survives into the
package, and `--install-extension` over an identical version is a no-op unless
forced.

Every one of these targets lives in the **root `Makefile`**, which is the whole
build system and not a shim that includes one: a developer who clones the repo
and types `make` finds the actions where `make` looks for them.

| Target | Contract |
|---|---|
| `make reinstall-vsix` | uninstall → kill → `clean` → `_build-vsix` (Rust host + both sidecars + extension, payload verified, packaged for the host platform) → install. The whole loop. |
| `make install-vsix` | install `dist/sharplsp.vsix` as it stands. Fails if it is absent. |
| `make uninstall-vsix` | remove the installed extension. Succeeds when nothing is installed. |

Requirements:

1. The loop MUST work identically on **macOS, Linux and Windows**. Windows runs
   these recipes under Git Bash, where the VS Code CLI is a `.cmd` shim, so the
   CLI MUST be resolved by probe — `code`, `code.cmd`, then the default per-user
   and machine-wide install locations — and overridable with `CODE=/path/to/code`.
   A missing CLI MUST fail loudly, never silently skip the install.
2. The VSIX path passed to the CLI MUST stay repo-relative. Git Bash absolute
   paths (`/c/...`) are not intelligible to a Windows `code.cmd`.
3. The extension identifier MUST be derived from the extension manifest
   (`publisher` + `name`), never hardcoded. A hardcoded copy drifts: the repo
   carried a dead `_uninstall-vsix` naming `sharplsp.sharp-lsp` long after the
   extension became `nimblesite.sharplsp`, so it could not have uninstalled
   anything.
4. Steps MUST be ordered explicitly as sub-makes, not as prerequisites of one
   target. Under `make -j` prerequisites run concurrently, and `clean` racing the
   build it feeds deletes that build's output.
5. `install-vsix` MUST pass `--force`, so reinstalling the same version replaces
   it instead of no-opping.
6. The uninstall MUST run **before** the clean and rebuild, not after. A build
   that fails midway then leaves no stale SharpLsp loaded in VS Code to be
   mistaken for the change under test.
7. The loop MUST resolve the host platform itself. There is ONE reinstall
   target, not one per platform: the developer running it is on the machine
   being installed into, and the dev VSIX carries that platform's host binary
   and that platform's debug adapter. Building for a platform you are not on is
   `_package-vsix-<platform>`, which packages and never installs.
8. Every target above MUST live in the **root `Makefile`**, which is the build
   system itself and not a shim that includes one, and every target that is not
   in the table MUST be prefixed `_`. The prefix is the public/private boundary:
   a tool that lists this file's targets shows the dozen a developer runs, not
   the seventy the build is made of.
9. The loop MUST verify the VSIX payload ([DIST-VSIX-CONTENTS]) **before** it
   installs, and the verification MUST run while the staged `bin/` is still on
   disk. Every copy and rename in the staging step ends in `2>/dev/null || true`,
   so a stage that half-ran is indistinguishable from one that worked: packaging
   proceeds, `--install-extension` succeeds, and the developer meets the missing
   host, sidecar or debug adapter as activation failures instead of as a build
   error. The test path has always gated on this; the path a developer actually
   runs to install their own build MUST gate on it too, or the only unverified
   VSIX the project produces is the one most likely to be broken.
10. The dev VSIX MUST be packaged with `--target <host platform>`. Without it the
    package carries no `TargetPlatform`, so VS Code treats a VSIX holding exactly
    ONE platform's host binary and debug adapter as installable on every
    platform. Every released VSIX is built with `--target`, so omitting it here
    also means the loop never exercises the shape that ships.
