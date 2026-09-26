# [DIST-SPEC] Distribution Specification

This is the normative specification for SharpLsp distribution: the components every
install carries, how each editor finds them, how a release is cut and published, and
the CI that gates every change on the way there.

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
6. When the workspace pins an SDK, `dotnet.acquireGlobalSDK` MUST request that **exact pinned version** rather than the `10.0` band, so the install actually satisfies the pin instead of landing in a band `global.json` rejects. The pin does **not** replace the sidecars' independent SDK/runtime requirement: every selected host, including alternate roots and acquisition results, MUST carry an SDK >= 10 and report a `Microsoft.NETCore.App` runtime meeting the `10.0.0` floor through a successful, bounded `dotnet --list-runtimes` probe. Both sidecars use `LatestMajor`: a prerelease of the floor (`10.0.0-rc.2`) is below it, but a newer prerelease (`10.0.99-rc.1` or `11.0.0-preview.1`) can satisfy it. Blanket prerelease rejection is incorrect. If an older pinned SDK is acquired into a root lacking that capability, also acquire the `10.0` SDK and revalidate that one root satisfies **both** requirements. If no such root exists after acquisition, return an actionable failure, never success with a .NET 9-only host. An already-installed sidecar host that cannot satisfy the pin MUST NOT bypass automatic acquisition: request the exact pinned SDK through the Install Tool, rather than return a host with broken builds or require the user to click an Install button. Acquisition stays bounded and uses non-interactive progress; any OS elevation UI belongs to Microsoft's installer. Never modify or silently relax `global.json`. Regression #297 is covered by real SDK installations and execution of both staged release sidecars, not empty executable/directory fixtures. Runtime selection cases remap real runtime directories to exercise hostfxr ordering; they do not claim to install prerelease runtime builds.
7. **Zero incompatible-SDK fallbacks.** If automatic acquisition fails, or its result cannot satisfy either requirement, return `Err` and surface it per [DIST-FAILURE-UX]. Never continue successfully on an existing unpinned host after an installer failure. An unsatisfiable pin diagnosis names the pinned version, the `rollForward` policy, the `global.json` that set it, and the SDKs actually installed. `dotnet` writes those facts to the build task's terminal, which the task's `close: true` presentation disposes on exit, leaving the user only VS Code's generic `failed to launch (exit code: 155)`.

**Implementation reference:**
- `src/editors/vscode/src/global-json.ts` — pin discovery (`readSdkPin`), `rollForward` evaluation (`sdkSatisfiesPin`), installed-SDK enumeration.
- `src/editors/vscode/src/dotnetRuntime.ts` — `existingSdkSatisfiesWorkspace`, `describeSdkPinFailure`, pin-aware `tryFindExistingSdk` / `callAcquireSdk`.
- `src/editors/vscode/src/dotnet-host.ts` — bounded runtime probe and joint workspace-pin / sidecar-host validation.
- `src/editors/vscode/src/build.ts` — `diagnoseBuildFailure` turns a non-zero build exit into the pin diagnosis.
- `src/editors/vscode/src/test/suite/sdk-pin.test.ts` — regression suite.
- `src/editors/vscode/src/test/suite/sdk-sidecar-host.test.ts` — real-host acquisition and F#/C# startup regression suite for #297, run in the `workspace` chunk on Linux and Windows.
8. SharpLsp MUST set `DOTNET_ROOT` (the directory of `dotnetPath`) and the matching `DOTNET_ROOT_<ARCH>` on the environments passed to **both Shipwright's startup probes and the Rust LSP host**. The [architecture-specific variable takes precedence](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-environment-variables#dotnet_root-dotnet_rootx86-dotnet_root_x86-dotnet_root_x64), so an inherited value MUST NOT override the acquired host. Verification and execution use the same root, without changing the editor's global environment. Setting the root only after verification leaves both sidecars falsely reported as missing even after successful SDK acquisition.

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
3. **The registered SDK MUST come from the .NET root hosting this process — never from another root.** `QueryVisualStudioInstances` enumerates the SDKs of a SINGLE root: the one hostfxr picks from `DOTNET_ROOT` or the running host. Two roots is the ordinary state of a dev machine (a `dotnet-install.sh` copy in `~/.dotnet` beside an installer or Homebrew copy in `/usr/local/share/dotnet`), and they hold different SDKs — so the SDK satisfying `global.json` can be installed and still invisible to discovery (issue #295).

   Registering the SDK found in the *other* root is **not** the remedy: an SDK must be coherent with the runtime hosting the process. Measured on a two-root machine — same binary, same tests, only `DOTNET_ROOT` differing — cross-root registration turned `FileBasedPackageSpecEndToEndTests` from passing in 3s into `filebased-degraded` after 45s each, while in-root registration passed. A foreign SDK degrades project load rather than repairing it.

   The correct response to "the active root ships no Roslyn match" is therefore a **diagnostic, not a workaround**. The other roots MAY be scanned (`<root>/sdk/<version>` across `DOTNET_ROOT`, the `dotnet` muxer on `PATH`, and each platform's per-user and machine-wide install locations) for the sole purpose of naming a root that DOES ship the bundled Roslyn, so the user can repoint `DOTNET_ROOT` instead of reinstalling an SDK they already have. A prerelease directory (`10.0.100-preview.1.25080.5`) MUST still be read — `Version.Parse` rejects it outright. An unreadable root MUST contribute nothing rather than throw, because this runs on the diagnostic path.

   The warning MUST NOT claim "no installed .NET SDK ships Roslyn X": that is a claim about the machine made from evidence about one root, and on a two-root box it is false.

4. **SDK-registration failure MUST degrade, never crash.** Neither discovery nor registration may take the sidecar down: on any failure it logs one actionable hint and leaves MSBuild unregistered. The process MUST still reach `READY` and serve MSBuild-free requests (`solution/read`, `ping`, `shutdown`). Roslyn-backed handlers then fail per-request with a clear error rather than the whole sidecar crash-looping. This is a specialization of [DIST-FAILURE-UX] for the sidecar process.

The one-shot startup hint emitted on the degraded path is a sanctioned sidecar stderr write per [DIST-CLEAN-OUTPUT] (alongside the Roslyn-mismatch hint) — it is actionable, level-appropriate, and fires at most once per process, never per request.

**Implementation reference:**
- `src/sidecars/SharpLsp.Sidecar.CSharp/MSBuildInstanceSelector.cs` — `QueryInstalledSdks` (explicit `DiscoveryType.DotNetSdk` + neutral `WorkingDirectory`), `NewestInstancePath` fallback, `BuildDiscoveryFailedHint`; `Register` no longer calls `RegisterDefaults()`. Rule 3's diagnostic scan is `CandidateDotnetRoots` / `SdkCandidatesUnder` / `ElsewhereHint`, reached only from `WarnNoMatch` — registration stays within the queried instances.
- `src/sidecars/SharpLsp.Sidecar.CSharp.Tests/MSBuildInstanceSelectorTests.cs` — `DescribeElsewhere_points_at_DOTNET_ROOT_rather_than_a_reinstall` and `WarnNoMatch_does_not_claim_the_active_root_is_every_root` pin the wording; `Repo_pinned_sdk_ships_exactly_the_bundled_roslyn` names the active root's SDKs when the pin is unsatisfiable there, rather than asserting a bare non-null.
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

`dotnet.findPath` MUST use the `10.0` band — it is a discovery probe, and the pin is applied to its answer per [DIST-RUNTIME-ACQUIRE] rule 5. `dotnet.acquireGlobalSDK` MUST use the pinned version when acquiring the workspace SDK (rule 6); a global SDK install accepts a fully-qualified version. An additional acquisition of the sidecar SDK uses `10.0` when the older pinned installation lacks the required SDK/runtime.

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

Every supported VSIX package and test entry point MUST rebuild its complete payload from clean compiler output by default. A successful incremental build, a cached binary, or a previous test run is not proof of freshness.

The ONE exception is a consumer handed native output built by the same CI run from the same commit, which it declares by setting `VSIX_PREBUILT` (and `VSIX_SUITE_PREBUILT` for the compiled suite). Such output is not the stale incremental tree this section exists to refuse, and rebuilding it per shard would multiply the host, both sidecars and the debugger by the matrix width — hours added to every pull request ([DIST-CI-VSIX-SHARDS]). A prebuilt consumer MUST still stage and verify the payload; it MUST NOT skip staging. Release packaging ignores the flag: a tag never ships a binary its own run did not compile.

The default local and release entry points produce clean native binaries. An
enclosing fresh build passes the prebuilt flag into npm's packaging lifecycle so
that lifecycle cannot secretly rebuild the payload a second time.

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

## [DIST-ARCHIVE] Standalone Server Archive

The VSIX is how VS Code gets SharpLsp. It is not how anything else does. Rider,
Zed, Neovim, Helix, Emacs, a CI job running the server headless, and the Homebrew
and Scoop formulas in [DIST-PATH-INSTALL] all need the LSP host and both sidecars
with no extension wrapped around them. That is the **standalone server archive**,
published on every GitHub release alongside the VSIXs.

One archive per built platform, named for it:

| Platform | Asset |
|---|---|
| `linux-x64` | `sharplsp-linux-x64.tar.gz` |
| `linux-arm64` | `sharplsp-linux-arm64.tar.gz` |
| `darwin-arm64` | `sharplsp-darwin-arm64.tar.gz` |
| `win32-x64` | `sharplsp-win32-x64.zip` |
| `win32-arm64` | `sharplsp-win32-arm64.zip` |

`.tar.gz` on Unix, `.zip` on Windows, produced by `make _package-archive`
(`tools/packaging/archive.sh`).

### [DIST-ARCHIVE-LAYOUT] Archive Layout

The layout is not a convention — it is dictated by the host's own sidecar
resolution (`installed_sidecar_exe` in `src/sharplsp/src/sidecar/manager.rs`,
layout 1: `<exe_dir>/<subdir>/<name>`). Unpack anywhere and run `sharplsp`; the
sidecars resolve with no environment variables, no PATH entries, and no
configuration.

```
sharplsp-<platform>/
  sharplsp[.exe]
  sidecar-csharp/
    SharpLsp.Sidecar.CSharp[.exe]      + managed assemblies
  sidecar-fsharp/
    SharpLsp.Sidecar.FSharp[.exe]      + managed assemblies
```

1. **Sidecar executables keep their published assembly names here.** The VSIX
   renames them to `sharplsp-sidecar-*` because the extension hands the host
   explicit paths through `SHARPLSP_CSHARP_SIDECAR_PATH` and
   `SHARPLSP_FSHARP_SIDECAR_PATH`. The archive has no such helper, so the names
   MUST be the ones the host looks for unaided.
2. **The archive does NOT bundle netcoredbg.** Debugging is a VS Code extension
   feature ([DIST-DEBUGGER-BUNDLE]); the archive ships the language server only.
3. **The archive does NOT bundle a .NET runtime.** Like the VSIX, the sidecars are
   framework-dependent and require the .NET 10 SDK ([DIST-RUNTIME-ACQUIRE]). An
   archive consumer acquires it themselves — there is no .NET Install Tool outside
   VS Code.

### [DIST-ARCHIVE-VERIFY] Archive Verification

`tools/packaging/verify-archive.sh <platform> [expected-version]` is the single
verifier. The `build-platform` action runs it on every pull request for the one
build that packages an archive (`linux-x64`), and `release.yml` runs it in
`build-vsix` for every platform of a tag. It makes two assertions, neither
sufficient alone:

1. **Layout.** The five paths above are present under `sharplsp-<platform>/`. A
   rename or a moved directory breaks every non-VS-Code editor while every VSIX
   check stays green.
2. **Execution.** The archive is unpacked and all three binaries are run. A .NET
   apphost separated from its managed assembly still EXISTS but cannot start —
   the same failure `VERIFY_STAGED_SIDECARS` guards for the VSIX stage, and one
   no listing can detect. `SKIP_RUN=1` reduces this to the layout check for a
   cross-compiled target the runner cannot execute (`win32-arm64`, whose release
   matrix entry sets `can_execute: false`).

## [DIST-RESOLUTION] Binary Resolution

Resolution is driven by the `sources` array of each component in
`src/editors/vscode/shipwright.json`. `activateShipwright`
(`@nimblesite/shipwright-vscode`, called from `src/editors/vscode/src/deployment.ts`)
resolves and verifies all three on activation. Failure to resolve any required
component triggers [DIST-FAILURE-UX] (degraded mode + toast), not a host-crashing
throw.

### [DIST-RESOLUTION-LSP] LSP Host

`sharplsp` (LSP server — native binary).

Sources: `["user-setting", "env", "bundled", "path", "pkgmgr"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.lspPath` VS Code setting — absolute path; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_LSP_PATH` (full path) or `SHARPLSP_BINARY_DIR` (directory); version drift = `ok-with-warning` |
| 3 | **`bundled`** | `bin/<platform>/sharplsp[.exe]` inside `extensionPath` ← **DEFAULT for all users** |
| 4 | `path` | `sharplsp` on `$PATH`; exact version match required |
| 5 | `pkgmgr` | No binary: Shipwright answers with the install commands `brew install nimblesite/tap/sharplsp` / `scoop install nimblesite/sharplsp` |

### [DIST-RESOLUTION-CSHARP] C# Sidecar

`sharplsp-sidecar-csharp` (C# Roslyn sidecar — .NET assembly).

Sources: `["user-setting", "env", "bundled", "path"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.csharpSidecarPath` VS Code setting; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_CSHARP_SIDECAR_PATH` (full path) |
| 3 | **`bundled`** | `bin/all/sharplsp-sidecar-csharp[.exe]` inside `extensionPath` ← **DEFAULT for all users** |
| 4 | `path` | `sharplsp-sidecar-csharp` on `$PATH`; exact version match required |

**If the bundled binary is missing the VSIX is broken — fix the build, not the resolution.** Surface per [DIST-FAILURE-UX].

### [DIST-RESOLUTION-FSHARP] F# Sidecar

`sharplsp-sidecar-fsharp` (F# FCS sidecar — .NET assembly).

Sources: `["user-setting", "env", "bundled", "path"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.fsharpSidecarPath` VS Code setting; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_FSHARP_SIDECAR_PATH` (full path) |
| 3 | **`bundled`** | `bin/all/sharplsp-sidecar-fsharp[.exe]` inside `extensionPath` ← **DEFAULT for all users** |
| 4 | `path` | `sharplsp-sidecar-fsharp` on `$PATH`; exact version match required |

**F# is first-class. No SharpLsp without F# support. If the bundled binary is missing the VSIX is broken — fix the build.** Surface per [DIST-FAILURE-UX].

## [DIST-VERSION-MATCH] Version Mismatch Behavior

Every component uses `versionCheckStrategy: "version-flag"`: Shipwright runs the
candidate with `--version` ([DIST-VERSION-OUTPUT]) and compares the result with
the manifest's expected version.

| Source | Version mismatch behaviour |
|---|---|
| `user-setting` | Hard error — surfaced via [DIST-FAILURE-UX], degraded mode |
| `env` | `ok-with-warning` — activation continues |
| `bundled` | `ok-with-warning` — activation continues |
| `path` | Skipped (no match) — falls through to the next source |

A binary whose `--version` names a different component is a hard error from any
source: it is the wrong executable, not an old one.

## [DIST-VERSION-INVARIANT] Release Version Invariant

The tag is the version. `release.yml` builds the tagged SHA verbatim — no branch
detection, no commit, no push. Each build job stamps the tag's version into its
own checkout with `make _stamp-version VERSION=<version>` before it builds: the
root and Zed `Cargo.toml`, the Zed `extension.toml`, the Rider plugin's
`pluginVersion`, the VS Code `package.json` and `package-lock.json`, and the
`product.version` of both `shipwright.json` manifests. The sidecars take the same
version at publish time (`-p:Version` and `-p:PackageVersion`).

All versions MUST match byte-for-byte for a release to be valid. Shipwright's
activation probes ([DIST-VERSION-MATCH]) are where a mismatch surfaces to a user.

## [DIST-VERSION-OUTPUT] Version Command Output

| Binary | Expected stdout |
|---|---|
| `sharplsp --version` | `sharplsp <semver>` |
| `sharplsp-sidecar-csharp --version` | `sharplsp-sidecar-csharp <semver>` |
| `sharplsp-sidecar-fsharp --version` | `sharplsp-sidecar-fsharp <semver>` |

The first whitespace-delimited token MUST exactly match the component `id` in
`shipwright.json`. `sharplsp --version --json` prints the host's Shipwright
`VersionSpec` — `name: "sharplsp"`, `version`, `kind: "lsp"`, `language: "rust"`,
`product: "sharplsp"`. CI checks both host forms in the `version-contract` job
and both sidecars in the .NET leg ([DIST-CI-SMOKE]).

## [DIST-EDITOR-CONTRACT] Editor Activation Contract

The VS Code extension resolves all three components through
`@nimblesite/shipwright-vscode` (`activateShipwright`). The extension MUST:

1. **Never hand-roll binary resolution** — use `activateShipwright` exclusively.
2. **Never download binaries over HTTPS** — all binaries ship in the VSIX, except the .NET 10 SDK, which the .NET Install Tool acquires ([DIST-RUNTIME-ACQUIRE]).
3. **Never treat any sidecar as optional** — both sidecars are required; a missing one puts activation into degraded mode ([DIST-FAILURE-UX]).
4. **Surface every failure per [DIST-FAILURE-UX]** if any component returns `status: "error"`. The .NET 10 SDK is NOT a bundled component; failure to acquire it enters degraded mode per [DIST-RUNTIME-ACQUIRE].
5. **Pass the Shipwright-resolved paths** to the language client — the host through `LanguageClient`, the sidecars through `SHARPLSP_CSHARP_SIDECAR_PATH` / `SHARPLSP_FSHARP_SIDECAR_PATH` — never a hardcoded binary path.
6. **Acquire the .NET 10 SDK at activation start** — `dotnet.findPath`, then `dotnet.acquireGlobalSDK` only when no compatible SDK exists ([DIST-RUNTIME-ACQUIRE]) — behind a non-interactive progress notification and status-bar spinner. SharpLsp's own UI never prompts or blocks on user action.
7. **Use `Result<T, E>` everywhere** per [DIST-FAILURE-UX]. No `throw` inside extension code; no unhandled rejections out of `activate()`.

## [DIST-WORKSPACE-TRUST] Workspace Trust

An untrusted workspace MUST NOT select an executable or inject process arguments. `src/editors/vscode/package.json` declares `capabilities.untrustedWorkspaces.supported: "limited"` and restricts `sharplsp.lspPath`, `sharplsp.csharpSidecarPath`, `sharplsp.fsharpSidecarPath`, `sharplsp.server.extraArgs`, `sharplsp.fsi.extraArgs`, and `sharplsp.debug.netcoredbgPath`.

While `workspace.isTrusted` is false, the runtime guards in `src/editors/vscode/src/config.ts` MUST return no custom LSP path, server arguments, or FSI arguments, leaving Shipwright's bundled binaries in use. When `workspace.onDidGrantWorkspaceTrust` fires, `src/editors/vscode/src/extension.ts` MUST restart the language client so newly trusted path and argument settings take effect without a window reload.

## [DIST-PATH-INSTALL] PATH Installation

Users who want `sharplsp` on their system PATH outside VS Code may install via:

- **macOS/Linux**: `brew install nimblesite/tap/sharplsp`
- **Windows**: `scoop install nimblesite/sharplsp`

Both draw from the [DIST-ARCHIVE] assets. This is entirely optional for VS Code
users — the bundled VSIX binary is sufficient. It is NOT optional for anyone
else: a Rider, Zed, Neovim or Helix user installs one of these or unpacks the
archive by hand.

### [DIST-PATH-PUBLISH] Tap and Bucket Publication

`release.yml`'s `publish-homebrew` and `publish-scoop` jobs push
`Formula/sharplsp.rb` to `Nimblesite/homebrew-tap` and `bucket/sharplsp.json` to
`Nimblesite/scoop-bucket` after the GitHub release succeeds
(`tools/packaging/publish-package-repo.sh`). Two jobs, not one: a tap outage must
not block the bucket, the same independence `publish-marketplace` and
`publish-openvsx` keep from each other.

1. **Both files are generated whole, never edited in place.**
   `tools/packaging/render-package-manifests.mjs` builds them from the release
   archives it just downloaded — the Scoop manifest as an object serialized to
   JSON, per the repo's structured-file rule. A rewrite-in-place is how a
   sha256 survives a version bump.
2. **Checksums come from the published bytes**, hashed from the `server-*`
   artifacts. The renderer fails if any expected archive is absent, so a short
   release cannot produce a formula pointing at a missing asset.
3. **The install layout is dictated by [DIST-ARCHIVE-LAYOUT].** Homebrew puts
   the host at `bin/sharplsp` and the sidecars at `lib/sharplsp/sidecar-*`
   (resolution layout 2); Scoop's `extract_dir` strips the archive root so the
   sidecars land beside `sharplsp.exe` (resolution layout 1). Shipping only the
   binary would install a language server that starts and then answers nothing.
   `tools/packaging/verify-package-manifests.mjs` asserts both, and runs on every
   PR from the `build-platform` action — the manifests themselves are only
   rendered on a tag, so otherwise the first sign of a break is a user's failed
   `brew install`.
4. **Prerelease tags are skipped.** Neither `brew install` nor `scoop install`
   has a prerelease channel, so pushing an rc would hand every stable user a
   prerelease on their next upgrade. Both jobs run only for a tag without a `-`.
5. **Neither formula declares a .NET dependency.** The sidecars target net10.0
   and Homebrew's `dotnet` formula is not pinned to it, so both manifests carry
   a note instead ([DIST-RUNTIME-ACQUIRE]).
6. Push credentials are `BREW_SCOOP_PAT` ([DIST-SECRETS]). Both jobs fail on a
   missing secret before checking anything out — the target repos are public, so
   an absent token clones happily and only fails at `git push`, after the release
   is already out.

**macOS x86_64 is not covered.** No `darwin-x64` archive is published (that build
hangs on GitHub's hosted `macos-13` runners), so the formula declares
`depends_on arch: :arm64` under `on_macos` to give Intel Macs a clear
architecture error instead of a 404 mid-download.

## [DIST-RELEASE] Release Workflow

Tag-triggered (`v*`). Jobs:

1. **`version`** — extracts the version from the tag and validates the Shipwright
   manifests. The tagged SHA is built verbatim; stamping is runner-local per job
   ([DIST-VERSION-INVARIANT]).
2. **`codeql`** — release gate: `codeql.yml` with `gate: true`, so a High/Critical
   finding on the released commit blocks every downstream publish
   ([DIST-CI-SECURITY]).
3. **`audit`** — release gate: the same `ci-audit.yml` every PR runs, re-run on
   the tagged SHA, so a vulnerable dependency blocks every downstream publish
   ([DIST-CI-AUDIT]).
4. **`build-vsix`** — one job per platform (`linux-x64`, `linux-arm64`,
   `darwin-arm64`, `win32-x64`, `win32-arm64`). Builds the Rust host and both
   sidecars ONCE, then emits BOTH artifacts for that platform: the
   platform-targeted `.vsix` and the standalone server archive ([DIST-ARCHIVE]).
   Verifies each before upload, including that the VSIX carries no other
   platform's host ([DIST-CI-SMOKE]).
5. **`build-rider`** — `./gradlew buildPlugin` on JDK 21, producing
   `sharplsp-rider.zip` ([DIST-RIDER-RELEASE]).
6. **`release`** — needs every job above. Creates the GitHub release with every
   VSIX, every server archive, the Rider plugin zip, and a `SHA256SUMS` covering
   all of them. Fails unless `SHA256SUMS` lists exactly `2 × PLATFORM_COUNT + 1`
   assets, so a release cannot silently ship short. A hyphenated SemVer tag
   (`v0.2.0-rc.1`) is published as a prerelease.
7. **`deploy-pages`** — deploys the tagged website revision. This is the only
   route by which the site deploys: `deploy-pages.yml` has no push trigger, so
   the site can never advertise something no release has shipped.
8. **`publish-marketplace`** / **`publish-openvsx`** — push the VSIXs only.
   Independent of each other; neither gates the other ([DIST-SECRETS]).
9. **`publish-homebrew`** / **`publish-scoop`** — push the rendered formula and
   manifest to the tap and bucket ([DIST-PATH-PUBLISH]). Skipped for prerelease
   tags.

## [DIST-RIDER-RELEASE] Rider Plugin Release

JetBrains users have no VSIX to install and no marketplace listing to pull from,
so `sharplsp-rider.zip` on the GitHub release IS the distribution channel for
Rider. `build-rider` therefore runs with `RIDER_REQUIRED=1`: a missing JDK is a
hard failure, not the local convenience skip `tools/rider/gradle.sh` allows,
because a silent skip would publish a release with no Rider plugin while
reporting success ([DIST-CI-RIDER]).

1. The plugin zip MUST carry the tag's version. `pluginVersion` in
   `src/editors/rider/gradle.properties` is stamped by `make _stamp-version`
   along with every other manifest ([DIST-VERSION-INVARIANT]); the job asserts
   that `build/distributions/sharplsp-rider-<version>.zip` exists.
2. The plugin does NOT bundle the LSP host. It resolves `sharplsp` from its
   project setting, then `~/.local/bin`, then `PATH` — so a Rider user installs
   a [DIST-ARCHIVE] asset or a [DIST-PATH-INSTALL] package first.
3. The plugin id is `com.sharplsp.rider` and every custom request it issues uses
   the `sharplsp/` method prefix the host answers on.

## [DIST-SECRETS] Publishing Credentials

The VS Code Marketplace publishes **passwordless via Microsoft Entra ID OIDC** (workload identity federation) — there is **no** long-lived Marketplace PAT. The `release.yml` `publish-marketplace` job runs in the `release` GitHub Environment so its OIDC subject is the deterministic `repo:Nimblesite/SharpLsp:environment:release`, which one Entra federated credential trusts. Open VSX has **no** OIDC/trusted-publishing path (verified 2026), so it still requires a long-lived access token.

| Secret / Variable | Scope | Purpose |
|---|---|---|
| `BREW_SCOOP_PAT` | repo | PAT with `contents:write` on `Nimblesite/homebrew-tap` and `Nimblesite/scoop-bucket` |
| `AZURE_CLIENT_ID` | `release` env | Entra ID app (client) id — Marketplace OIDC publish. Not sensitive; no PAT involved. |
| `AZURE_TENANT_ID` | `release` env | Entra ID tenant (directory) id — Marketplace OIDC publish. |
| `OPEN_VSX_PAT` | repo | Open VSX access token. No OIDC path exists; long-lived token required (rotate on a schedule — post-2025 tokens expire by default). |

## [DIST-FORBIDDEN] Forbidden Distribution Patterns

- `https.get(...)` / `fetch(...)` / `child_process` spawning for downloading any binary, including .NET. The .NET SDK is delegated exclusively to the .NET Install Tool extension (see [DIST-RUNTIME-ACQUIRE]); other binaries ship in the VSIX.
- `dotnet tool install` / `dotnet tool update` as a distribution mechanism for VSIX users.
- Treating either sidecar as optional — both are required, both surface a degraded-mode toast if missing.
- Writing any component binary into `~/.local/`, temp dirs, or paths not managed by Shipwright or the .NET Install Tool.
- Hand-rolling binary resolution — use `activateShipwright` exclusively ([DIST-EDITOR-CONTRACT]).
- Hand-rolling .NET SDK acquisition — `dotnet.findPath` and `dotnet.acquireGlobalSDK` from the .NET Install Tool are the only sanctioned mechanism.
- Calling the .NET Install Tool without **all four required fields** of `IDotnetAcquireContext` (`version`, `mode`, `architecture`, `requestingExtensionId`) — see [DIST-API-PARAMETERS].
- Skipping version verification on activation.
- Shipping a single universal VSIX containing all platform binaries.
- Modal prompts, dialogs, or any UI that *requires* user action during .NET SDK acquisition. The user must be informed (progress notification + status bar) but never asked to do anything.
- **`throw` inside extension code, or any code path that allows `activate()` to reject** — see [DIST-FAILURE-UX]. Use `Result<T, E>` and surface a non-modal toast.
- **Failing silently when activation cannot deliver a language server** — every failure mode MUST produce a visible notification with at least a `[Show Log]` action and a recovery command in the palette.

## [DIST-CI-LAYOUT] CI Workflow Layout

The PR pipeline runs in FIVE STRICTLY ORDERED PHASES. Each phase is a reusable
workflow (`on: workflow_call`) called by `ci.yml`:

```
detect-changes -> ANALYSE -> FULL BUILD (linux || windows) -> TEST -> COVERAGE -> CI
```

| Phase | Workflow | Leg |
|---|---|---|
| — | `ci.yml` | Orchestrator: `detect-changes` ([DIST-CI-CLASSIFICATION]), one `uses:` job per phase, and the terminal `CI` gate ([DIST-CI-PROTECTION]) |
| 1 ANALYSE | `ci-analyse.yml` | Every Rust / Zed / .NET / VS Code lint, format and analysis gate, including duplication ([DIST-CI-DESLOP]) and spec citations ([DIST-CI-SPEC-CITATIONS]) |
| 1 ANALYSE | `ci-audit.yml` | `make audit`: vulnerable Rust / .NET / npm dependencies already in the tree ([DIST-CI-AUDIT]) |
| 1 ANALYSE | (in `ci.yml`) | Dependency review ([DIST-CI-SECURITY]) and Shipwright manifest validation ([DIST-CI-SMOKE]) |
| 2 BUILD + 3 CACHE | `ci-build.yml` | Both platforms in parallel: host, sidecars, netcoredbg, VS Code suite, VSIX, standalone archive — then published |
| 4 TEST | `ci-test-rust.yml` | Sharded Rust e2e suite ([DIST-CI-RUST-SHARDS]), the version contract ([DIST-VERSION-OUTPUT]) |
| 4 TEST | `ci-test-dotnet.yml` | Sidecar tests (Ubuntu) + the win32 named-pipe arm ([DIST-CI-WIN-TRANSPORT]) |
| 4 TEST | `ci-test-vsix.yml` | Instrumented VS Code feature chunks (Ubuntu, [DIST-CI-VSIX-SHARDS]) |
| 4 TEST | `ci-test-vsix-windows.yml` | Instrumented VS Code feature chunks (Windows, [DIST-CI-WIN-VSIX]) |
| 4 TEST | `ci-test-editors.yml` | Zed + Rider ([DIST-CI-EDITORS]) |
| 4 TEST | `ci-test-tooling.yml` | The repo's own build tooling — how the netcoredbg adapter is obtained ([DIST-DEBUGGER-BUNDLE]) |
| 5 COVERAGE | `ci-coverage.yml` | The two SHARDED ratchets — Rust, and VS Code over both platforms ([DIST-CI-VSIX-COVERAGE]) |

CodeQL (`codeql.yml`, [DIST-CI-SECURITY]), the release (`release.yml`,
[DIST-RELEASE]) and the Pages deploy it calls (`deploy-pages.yml`), the Dependabot
sweep (`dependabot-automerge.yml`, [DIST-CI-DEPENDABOT]) and the patched-debugger
publication (`publish-netcoredbg.yml`, [DIST-DEBUGGER-BUNDLE]) are separate
workflows with their own triggers.

Phase invariants:

- **ANALYSE gates everything and builds nothing.** No later phase consumes an
  artifact from phase 1. Lint used to share a job with the Ubuntu build, which
  meant the Windows build waited on both.
- **PHASE 2 builds every platform, once, in parallel.** `build-linux` and
  `build-windows` are SIBLINGS — neither `needs:` the other, because neither
  consumes the other's output. Gating Windows on the Ubuntu build put 6m45 of
  idle Windows runner, and then 11m02 of duplicate Windows building, in front of
  the slowest tests in the pipeline.
- **PHASE 3 is the handoff boundary.** Everything phase 4 needs is uploaded at
  the end of phase 2, and NO test leg may rebuild a shipping artifact
  ([DIST-CI-ARTIFACT-TESTS]).
- **EACH ARROW IS THE ONLY DEPENDENCY.** Every phase-4 leg is
  `needs: [detect-changes, build]` and guarded by `code_changed`. No test leg
  `needs:` another test leg.
- **EVERY TEST RUNS EXACTLY ONCE.** No suite may execute in two jobs. Where a
  platform arm genuinely differs, only the platform-dependent classes run twice
  — the Windows transport job runs `_test-dotnet-win-transport`, not the whole
  Common test project.
- **PHASE 5 gates only what phase 4 could not.** A ratchet needs a complete
  tracefile. The sharded suites (Rust partitions, VS Code chunks) have none in
  any single job, so they merge and gate in `ci-coverage.yml`; the unsharded
  legs (.NET, Zed, Rider) gate inside their own test job.
- **An install is cached by its RESULT, not its inputs.** `npm ci` for the
  VS Code extension costs 3m16 on Ubuntu and 4m31 on Windows even with a warm
  `~/.npm`, because the cost is unpacking 524 packages and running their
  install scripts, not downloading them. Every phase-4 shard pays it, so it is
  paid ~30 times per run, each time on that job's critical path. The
  `vsix-node-deps` composite action caches `node_modules` itself, keyed on the
  lockfile hash plus OS and architecture (the tree carries platform-specific
  optional dependencies), with NO `restore-keys` — a partial tree from a
  different lockfile would skip `npm ci` and be silently wrong. Every VS Code
  `npm ci` in the PR pipeline goes through it.
- **Legs are called, never duplicated.** Per-platform build logic lives in the
  `build-platform` composite action, per-shard logic in `vsix-shard`, and shared
  build logic in the `Makefile`, so a step is written once and called from every
  workflow that needs it. The Ubuntu and Windows VS Code legs run the SAME
  composite action and the SAME make target; they had already drifted apart
  once, to the point where Windows ran its whole suite uninstrumented.
- **No job commits or pushes.** On a pull request `actions/checkout` is a
  detached HEAD, and a bot push to a protected branch is what
  [DIST-CI-PROTECTION] refuses. A raised coverage floor lands in the PR that
  raised it ([DIST-CI-COVERAGE-THRESHOLDS]).

### [DIST-CI-CLASSIFICATION] Fail-Closed Change Detection

The PR workflow MUST successfully retrieve every page of changed files before deciding which checks can skip. An API error, including failure after partial output, or an empty response MUST fail `detect-changes` without publishing classification outputs. The terminal `CI` job MUST depend on every upstream job and fail on any failure or cancellation. The active main-branch ruleset MUST require this exact GitHub Actions check with no bypass actors; build/test failures and pending checks cannot be merged.

Product tests MUST run on pull requests only, not on a push or merge to main. `tools/ci/changed-files.test.mjs` executes the workflow's actual Bash classifier, covering failed, partial, empty, docs-only, code and manifest responses, and guards the terminal dependency list and PR-only trigger. It MUST run through `make _lint-vsix` in CI.

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

### [DIST-CI-PROTECTION] Branch Protection and the Terminal Gate

`main` changes only through a reviewed pull request, and only when CI says so.
The `main-protection` repository ruleset (active, targeting the default branch)
enforces it with NO bypass actors:

- Every change arrives by pull request and merges by squash only, keeping a
  linear history. Direct pushes, force pushes and branch deletion are refused.
  No approving review is required: the checks are the gate.
- The one required status check is `CI`, the terminal job of `ci.yml`.
- Classic branch protection repeats the gate with `enforce_admins` on, so an
  administrator cannot merge past a red check either. It requires `CI` plus the
  PHASE 1 jobs and CodeQL: Detect Changed Paths, Dependency Review, Validate
  Shipwright Manifest, and `Analyze` for every CodeQL language.

`CI` is the ONE fixed context because the pipeline's own check names change with
its matrices — the VS Code chunks are computed at runtime from `test-chunks.json`
and cannot be named in a ruleset at all. The job `needs:` every other job in
`ci.yml` and runs `if: always()`, so it reports a real conclusion instead of
inheriting a skip:

1. Any upstream job that FAILED or was CANCELLED fails `CI`, and with it the merge.
2. A SKIPPED upstream job satisfies it. That is how a docs-only PR (every job
   skipped by [DIST-CI-CLASSIFICATION]) and a Dependabot PR (the whole pipeline
   skipped, [DIST-CI-DEPENDABOT]) pass.
3. No workflow runs the PR pipeline on a push to `main`; a merge is verified by
   the PR run that produced it.

## [DIST-CI-SECURITY] Security Gates

[ci.yml](../../.github/workflows/ci.yml) MUST run dependency review for every pull
request, failing on a newly introduced dependency with a high-or-worse advisory,
and the dependency audit ([DIST-CI-AUDIT]). [codeql.yml](../../.github/workflows/codeql.yml)
MUST scan pull requests, a weekly schedule (new queries re-scan unchanged code),
and tagged releases; `release.yml` calls it with `gate: true`, and any high or
critical finding blocks release and publication ([DIST-RELEASE]). Dependency
review owns the vulnerable dependencies a PR ADDS, the audit owns those already in
the tree, and CodeQL owns vulnerable code. CodeQL runs while the repository is
public, where code scanning needs no Advanced Security licence, and skips
Dependabot PRs ([DIST-CI-DEPENDABOT]).

Every workflow defaults its token to `permissions: contents: read`. A job widens
only what it uses — CodeQL `security-events: write`, the GitHub Release
`contents: write`, the Pages deploy `pages: write` and `id-token: write`, the
Marketplace publish `id-token: write` for OIDC ([DIST-SECRETS]) — so a permissive
repository default never reaches a job that does not need it.

### [DIST-CI-AUDIT] Dependency Vulnerability Gate

`make audit` MUST scan both Cargo lockfiles (host and Zed), the sidecar NuGet solution including transitive packages, and both npm lockfiles (VS Code and website) against current advisory databases. Rust vulnerability findings fail the gate; NuGet and npm fail at moderate or higher by default, including every high/critical finding. Lower-severity findings remain visible. Scanner or restore failures MUST fail, not count as a clean result.

CI and tagged releases MUST call the same reusable `ci-audit.yml` workflow. The final CI job MUST include `audit` in its dependencies and fail on its failure/cancellation. GitHub Release creation MUST depend on a successful audit of the tagged revision, and Marketplace/Open VSX publishing MUST depend on that release. No `continue-on-error` or publish bypass is permitted. New advisories require a fresh release-time scan even when the PR previously passed.

Known vulnerabilities MUST be resolved by upgrading affected direct/transitive dependencies and testing compatibility, not by weakening thresholds or suppressing findings. A clean advisory scan is evidence about the scanned dependency inventory, not a guarantee that all bundled native binaries or runtime installations are vulnerability-free.

Regression guards: `tools/audit/dotnet-vulnerable.test.mjs` tests real vulnerable and clean NuGet reports; `tools/ci/security-gates.test.mjs` parses workflow YAML and verifies CI/release dependency enforcement. Both MUST run in CI.

### [DIST-CI-DEPENDABOT] Dependency Update Staging

Dependabot MUST NOT spend the PR pipeline on bumps that are about to be
superseded, and MUST NOT merge anything into `main` unattended.

1. `.github/dependabot.yml` covers every ecosystem the repository ships — Cargo
   (host and Zed), NuGet (sidecars), npm (VS Code extension and website) and
   GitHub Actions — weekly. Each ecosystem collapses all of its version bumps,
   majors included, into one grouped PR, and its security bumps into a parallel
   `*-security` group.
2. Version updates target the long-lived, UNPROTECTED `dependabot-upgrades`
   staging branch. GitHub ignores `target-branch` for security updates and opens
   them against `main`, so `dependabot-automerge.yml` runs on Dependabot PRs to
   BOTH branches: it merges each into `dependabot-upgrades` with
   `git merge -X theirs` — the latest bump of a lock file wins, so successive
   bumps never conflict-stall — and retires the PR.
3. `ci.yml` and `codeql.yml` skip every PR whose actor is `dependabot[bot]`. The
   staged batch is verified once, by the full pipeline and CodeQL, on the
   `dependabot-upgrades → main` consolidation PR — the only route a dependency
   change takes into `main`. A staged security fix reaches `main` when that PR
   is opened, so it is opened promptly.
4. `dependabot-automerge.yml` MUST exist on both branches: for `pull_request`,
   GitHub runs the workflow from the PR's BASE branch.

## [DIST-CI-DESLOP] Duplication Ratchet

Duplication in shipped code is gated in PHASE 1 by
[Deslop](https://github.com/Nimblesite/Deslop), in `ci-analyse.yml`.

1. **One source of truth.** The committed `.deslop.toml` owns both the threshold
   (`[threshold] max_duplication_percent`) and the `exclude` list — examples, test
   fixtures, test suites, and the sequestered formatting implementation that is
   not shipped. The CI step passes no threshold on its command line, so the
   number under review in a PR diff is the number enforced.
2. **Ratchet DOWN only.** A PR that reduces duplication lowers the threshold in
   the same PR; raising it needs a written justification in that PR.
3. **A verified binary or no gate.** `DESLOP_VERSION` pins the release; the step
   downloads the archive AND its published `.sha256` and verifies it before
   unpacking, because it runs a downloaded binary over the whole tree. A missing
   binary fails the step rather than skipping the gate.
4. `deslop .` exits non-zero (3) the moment measured duplication exceeds the
   threshold. Deslop's local index (`.deslop/`) and report files are git-ignored.

## [DIST-CI-SPEC-CITATIONS] Spec Citation Gate

Every spec ID cited anywhere in the repository — code, tests, workflows, build
tooling, documents — MUST resolve to a definition. A citation of a section that
no longer exists reads as "specified and reviewed" when nothing specifies it; 24
`[DIST-*]` sections were deleted that way while `release.yml` kept citing them
(GitHub #272, #301). `tools/ci/spec-citations.mjs` enforces it in
`make _lint-vsix`, over every file git tracks:

1. **Headings define.** A heading under `docs/` defines each ID it carries
   OUTSIDE parentheses. `### CI workflow layout ([DIST-CI-LAYOUT])` only
   mentions the section it summarises, so a plan heading cannot keep a deleted
   spec section alive.
2. **Citations resolve.** A citation resolves to the heading that defines it, or
   names a spec or plan document whole (`[DISTRIBUTION-SPEC]` is
   `docs/specs/DISTRIBUTION-SPEC.md`).
3. **One definition.** An ID defined by two headings fails: a citation of it
   cannot say which it means.
4. **Not a citation.** A bracketed name followed by an external URL
   (`[JSON-RPC](https://…)`) is a link. An ID's group is at least two
   characters, so a regex class such as `[A-Z]` is not an ID.
5. **The only exemptions** are the agent instructions' ID-format examples
   (`[GROUP-TOPIC]`, `[GROUP-TOPIC-DETAIL]`, `[AUTH-TOKEN-VERIFY]`), the
   `spec-check` skill and the gate's own test, whose every ID is an example.

The gate lexes markdown with a real parser, so a `#` line inside a fenced code
block defines nothing. Renaming or deleting a section therefore fails CI until
every citation of it moves in the same change.
`tools/ci/spec-citations.test.mjs` exercises each rule against a real git
repository.

## [DIST-CI-SMOKE] CI Smoke Checks

The cheap checks that prove a build is shippable at all run on every pull request,
before any feature test can fail for the same reason:

- `validate-manifest` validates both `shipwright.json` manifests against the
  Shipwright schema whenever a manifest or the schema changes.
- PHASE 2 publishes both sidecars (`dotnet publish --no-self-contained`), packs
  both, and verifies the staged payload before packaging ([DIST-VSIX-CONTENTS]):
  the payload must carry the host and both sidecars, and both staged sidecars
  must answer `--version` (`VERIFY_STAGED_SIDECARS`).
- The standalone archive is packaged, checked for layout and executed on
  `linux-x64` ([DIST-ARCHIVE-VERIFY]), and the Homebrew and Scoop renderers are
  exercised ([DIST-PATH-PUBLISH]).
- The patched debugger is built on the release's own macOS runner image on every
  PR (`build-macos` in `ci-build.yml`). The release rebuilds it from source for
  `darwin-arm64`, and a Linux- and Windows-only PR build cannot catch a macOS
  compiler or linker failure before a tag is pushed ([DIST-DEBUGGER-BUNDLE]).
- The version contract ([DIST-VERSION-OUTPUT]): the `version-contract` job runs
  `sharplsp --version` and `--version --json` against the PHASE 2 binary; the
  .NET leg runs both sidecars' `--version` against their MSBuild `Version`.
- Every VS Code shard first removes any SharpLsp component on the runner's
  `PATH` (`tools/vsix/purge-path-binaries.sh`), so the suite can only resolve the
  staged payload — a dev copy would substitute itself for the artifact under test
  and turn a broken bundle green.

A tag repeats the payload and archive checks for every platform, and asserts that
each platform's VSIX carries no other platform's host ([DIST-RELEASE]).

## [DIST-CI-NODE] Node.js Toolchain

**Minimum: Node.js 22.** `@vscode/vsce` 4.x, which the extension pins, declares
`engines.node >= 22`.

Ground truth: <https://github.com/microsoft/vscode-vsce>

All CI jobs that run `vsce package` or `vsce publish` MUST use `node-version: '22'` or
higher. `npm` reports a lower runtime only as an `EBADENGINE` warning, so the
workflows, not `npm`, have to hold the line (GitHub #310 tracks moving them off
Node 20). Do not upgrade beyond what vsce requires without checking the above URL
first.

## [DIST-CI-DOTNET] .NET Toolchain

**Required: .NET 10.** `global.json` pins the SDK, and every workflow installs that
same version; `tools/ci/check-sdk-pin.mjs` fails `make _lint-vsix` when the two
disagree ([DIST-RUNTIME-ACQUIRE]). All sidecar publish steps use
`dotnet publish --no-self-contained` targeting `net10.0`.

### [DIST-CI-DOTNET-DEPSFILE] Dependency File Generation

`src/sidecars/SharpLsp.Sidecar.Common/SharpLsp.Sidecar.Common.csproj` is a referenced-only class library and MUST set `<GenerateDependencyFile>false</GenerateDependencyFile>`. Its consumers generate their own runtime dependency files; emitting the unused `SharpLsp.Sidecar.Common.deps.json` lets concurrent builds or indexers lock the shared `bin/` artifact and fail `GenerateDepsFile` with MSB4018. `src/sharplsp/tests/build_deps_file_e2e.rs` MUST verify the evaluated MSBuild property, not project-file text (GitHub #111).

## [DIST-CI-RUST] Rust Toolchain

Stable toolchain. Cross-compilation targets must be added via `dtolnay/rust-toolchain@stable` with explicit `targets:`.

### [DIST-CI-RUST-SHARDS] Rust Test Shards

The Rust e2e suite runs single-threaded (`RUST_TEST_THREADS=1` — tests spawn real Roslyn/FCS sidecars), so its wall time scales with test count, not runner cores. CI therefore splits it into `SHARD_COUNT` (2) nextest **hash partitions** (`make _test-rust-shard SHARD=<n>`, i.e. `--partition hash:<n>/<count>`), run as the `test-rust` job matrix.

Invariants:

- **Same tests, same serialization.** A shard changes only *which* slice of the suite runs, never how: `--no-fail-fast` and the `--test-threads` serialization apply to every shard. Sharding MUST NOT skip, filter, or reorder tests beyond the partition itself.
- **One gate, over the union.** Each shard exports lcov (`target/coverage-rust-shard<n>.lcov`). No shard can meet the line threshold alone, so no shard runs the coverage gate; the `Rust` job of `ci-coverage.yml` union-merges the tracefiles (`make _gate-rust-coverage`, `tools/coverage/merge-lcov.mjs`) and enforces the identical `tools/coverage/check-coverage.mjs` ratchet a single-job run enforces. Every shard tracefile carries the full instrumented line set (unexecuted lines as `DA:<line>,0`), so the union reproduces exactly the line percentage of an unsharded run.
- **Local runs stay unsharded.** `make test` / `make _test-rust` remain the single-invocation JSON + inline-gate path; sharding is a CI wall-clock concern only.
- **Version contract is its own job.** The `--version` contract checks ([DIST-VERSION-OUTPUT]) run in the `version-contract` job against the PHASE 2 release binary: the release profile shares nothing with the instrumented test build, so bundling it into a test job serializes it onto the critical path for zero reuse.

## [DIST-CI-WIN-TRANSPORT] Windows Sidecar Transport

`tokio::net::UnixStream` is **unix-only** and MUST NOT be used unconditionally. All sidecar transport code MUST be gated:
- `#[cfg(unix)]` — use `tokio::net::UnixStream`
- `#[cfg(windows)]` — use `tokio::net::windows::named_pipe`; TCP loopback is not an IPC fallback

Both the Rust host and the .NET sidecar MUST use the same transport on each platform. Win32 builds failing to compile due to `UnixStream` is a hard blocker.

The .NET sidecars are platform-neutral assemblies shipped identically in every VSIX ([DIST-VSIX-LAYOUT]), so **their transport selection MUST be a runtime decision keyed on the endpoint shape**: an endpoint starting with `\\.\pipe\` selects a named pipe server/client; anything else selects a Unix domain socket. Compile-time gating (`#if WINDOWS`) is forbidden in sidecar transport code — the symbol is never defined for the platform-neutral `net10.0` build, which silently compiles the Unix branch into the Windows VSIX and makes the sidecars exit before READY (GitHub #110).

Both listener flavors MUST restrict the endpoint to the current user: `0600` on the Unix domain socket, `PipeOptions.CurrentUserOnly` on the named pipe server. Endpoint names MUST also be unpredictable and unique per spawn per [SIDECAR-STARTUP-ENDPOINT](SIDECAR-LIFECYCLE-SPEC.md), preventing concurrent hosts or an orphaned prior generation from intentionally sharing a name. Current-user restriction remains mandatory defense in depth. CI MUST run the sidecar transport tests on a Windows runner (`ci-test-dotnet.yml`, `make _test-dotnet-win-transport`) — an Ubuntu-only matrix never executes the named-pipe arm, which is how GitHub #110 shipped.

## [DIST-CI-WIN-VSIX] Windows VS Code End-to-End Tests

CI MUST run the VS Code end-to-end suite's whole feature surface on Windows runners through `ci-test-vsix-windows.yml` and `_test-vsix-shard` (the same target the Ubuntu leg runs): the release-built `sharplsp` host, Roslyn and FCS sidecars, actual VS Code extension host, and win32 named-pipe IPC. [DIST-CI-WIN-TRANSPORT] covers frames only, while Windows-specific executables (`netcoredbg.exe`, `dotnet-trace`, `dotnet test`, `dotnet new`) and paths require full feature coverage; a grep-selected smoke subset is insufficient.

The suite is sliced into **feature chunks**, one CI job each on BOTH platform legs, run with `fail-fast: false` so one failing feature area never hides the state of the others. A chunk is a GROUP of related feature areas, not a single one. `src/editors/vscode/test-chunks.json` is the single declaration of the chunks and of what each covers; a chunk marked `linuxOnly` is absent from the Windows matrix, and one marked `windowsOnly` from the Ubuntu matrix.

Invariants:

- **A chunk is a GROUP, and the matrix stays readable.** Each platform leg MUST fan out over roughly **6-10** jobs, never one job per feature area. Every job repeats the same multi-minute preamble — `setup-dotnet`, the extension's `node_modules`, three artifact downloads and the VS Code host cache — so a matrix of one-area jobs pays that fixed cost once per area, and at 26 Windows + 29 Ubuntu jobs it spent more runner time on preamble than on tests while producing a check list too long to read. Areas are grouped by what they exercise, so a red job still names a coherent surface. The counter-pressure is wall clock: a chunk projected past **~15 minutes** on either platform MUST be split, and a chunk that HANGS must not be able to take an unrelated surface down with it — which is why `testexplorer-frameworks` (the sleeping-fixture cancellation suite) stays out of `testexplorer`.
- **One declaration.** Chunk membership lives in `src/editors/vscode/test-chunks.json` and is read by `tools/vsix/vsix-test-chunks.mjs` (`files <chunk>` → `MOCHA_FILES` globs, `matrix` → the CI job matrix, `check` → the completeness guard). It MUST NOT be duplicated into CI YAML.
- **Nothing escapes.** `make _lint-vsix` runs `vsix-test-chunks.mjs check`, which fails if any `*.test.ts` suite is claimed by no chunk or by more than one. A new suite is therefore gated on Windows by default; opting out requires an explicit entry under `excluded` with a written reason.
- **Selection is by file, not by title.** The inner mocha runner selects suites via the `MOCHA_FILES` glob list. Title-regex selection (`MOCHA_GREP`) is a local debugging aid only — it silently drops tests when a suite is renamed. A glob matching zero compiled suites is a hard error, so a mistyped chunk fails instead of reporting a green run of nothing.
- **Build once, fan out.** Each platform's PHASE 2 build compiles the Rust host and both sidecars and publishes them as an artifact; each chunk job downloads and stages them (`VSIX_PREBUILT=1`). Rebuilding per chunk would cost one cold Windows Rust build per feature area.
- **Every shard is instrumented, on both platforms.** Windows chunks used to run **without** `--coverage`, which left the entire coverage number resting on Ubuntu and made win32-only code paths invisible to the ratchet. Both legs now run the same instrumented `_test-vsix-shard`, and one gate at the end of the pipeline ratchets the union ([DIST-CI-VSIX-COVERAGE]). Chunks marked `linuxOnly` — the real-repository stress suites, each cloning and restoring a pinned third-party repository — are absent from the Windows matrix: that is repo ingestion, not platform behaviour.
- **No PATH leakage.** Every VS Code job runs `tools/vsix/purge-path-binaries.sh` first, so the test host can only resolve the freshly-staged bundled binaries ([DIST-CI-SMOKE]).
- **One spelling of the temp root.** On the GitHub Windows runner `os.tmpdir()` reports the 8.3 short form (`C:\Users\RUNNER~1\AppData\Local\Temp`), while MSBuild, `dotnet` and every path derived from a built project report the long form. The suite runner canonicalises `TMPDIR`, `TEMP` and `TMP` once, before any suite builds a fixture (`src/editors/vscode/src/test/suite/index.ts`), so every suite, kit and spawned `dotnet` agrees on one spelling. Case folding cannot repair it: 8.3 is a different SPELLING of the path, not a different case.
- **Compare paths case-insensitively on Windows.** VS Code lowercases the drive letter whenever a path travels through `Uri.fsPath`, while `extensionPath` and `os.tmpdir()` preserve the original casing, so the same file legitimately has two spellings. Any assertion comparing a `Uri`-derived path against a directly-constructed one MUST go through `comparablePath()` (`test-helpers.ts`), which lowercases on win32 only — POSIX paths stay case-sensitive, because there `/tmp/A` and `/tmp/a` really are different files.
- **Suites MUST be order-independent.** Chunking changes which suites share an extension host, so no suite may depend on state another suite left in a shared singleton. Fixture identifiers that feed a shared registry — notably test method names discovered into the `SharpLspTestController` — MUST be unique per suite, or a test asserting "nothing matches" passes or fails on whichever suite's discovery won the race.

The LSP e2e temp-dir helper MUST fall back to `os.tmpdir()` (never a hardcoded `/tmp`) so these suites run on Windows.

## [DIST-CI-VSIX-SHARDS] VS Code Suite Shards

One runner, `make _test-vsix-shard CHUNK=<name>`, drives every slice of the VS Code end-to-end suite on every platform, always instrumented for coverage. The chunks are declared once, in `src/editors/vscode/test-chunks.json`, and the Ubuntu and Windows matrices both expand from it. Every shard uploads its extension-host logs (`vsix-logs-<platform>-<chunk>`) on every outcome, with the DAP trace enabled, so a green shard carries the evidence of WHICH path passed it — a fallback that fired leaves its line in those logs and nowhere else.

The Ubuntu leg MUST fan out over the same feature chunks the Windows leg uses
([DIST-CI-WIN-VSIX]), one chunk per job, and MUST NOT run the suite as a single
job. Unsharded, that job was the pipeline's critical path at 50 minutes — 18
spent executing tests and 30 spent burning two 15-minute mocha hook ceilings on
one hung suite. Sharding makes the leg's wall time the slowest single chunk
rather than the sum of all of them, and confines a hang to the chunk that hangs.

Invariants:

- **One declaration, both platforms.** `src/editors/vscode/test-chunks.json` is
  the single chunk manifest; `tools/vsix/vsix-test-chunks.mjs matrix linux` and
  `... matrix win` derive the two CI matrices from it. The only platform
  distinction the manifest carries is `"linuxOnly": true` or
  `"windowsOnly": true`, which drops a chunk from the other platform's matrix. A
  chunk MUST NOT be declared in CI YAML.
- **One runner, one shard target.** `make _run-vsix-suite` is the single recipe;
  `CHUNK` selects the slice (empty runs every suite) and `VSIX_SUITE_PREBUILT`
  says the suite is already compiled. Coverage is NOT a knob — the runner always
  instruments. `_test-vsix` (local, whole suite, gated inline) and
  `_test-vsix-shard` (ONE chunk on ANY platform) are thin wrappers and MUST NOT
  re-implement the invocation. There is no Windows-only variant: the two had
  already drifted to the point where one ran with coverage and one without.
- **Neither leg re-implements the other.** The three things both platform legs
  do live in `.github/actions/`: `vsix-suite` (install, resolve the matrix,
  compile once, publish), `vsix-shard` (stage, run one instrumented chunk,
  publish its tracefile and logs) and `vsix-payload` (pack the VSIX, assert the
  platform binary is in it). `ci-test-vsix.yml` and `ci-test-vsix-windows.yml`
  supply only what genuinely differs — artifact names, where the debugger
  unpacks, the platform tag, and whether the runner needs `xvfb`. Copying steps
  between the two YAMLs is how they drifted apart the first time.
- **Only the PORTABLE build is shared.** The suite artifact carries `out/` and
  `dist/` — tsc and esbuild output, identical on every runner. It MUST NOT carry
  `test-fixtures/`: `prepare:test-fixtures` runs `dotnet build`, and the
  `obj/project.assets.json` it writes points at the building machine's
  `~/.nuget/packages`. A shard handed those files loads a Roslyn workspace whose
  references do not resolve, which surfaces as missing definitions, a reduced
  refactor set and an empty unused-package report — failures that look like
  product bugs and are really a missing restore. Each shard builds the fixtures
  itself against a cached NuGet store.
- **Nothing is compiled or built twice.** The Rust host, both sidecars and
  netcoredbg are built once per platform and staged from artifacts
  (`VSIX_PREBUILT=1`). The suite itself — clean, tsc, esbuild bundle — is
  compiled once per platform by `_build-vsix-suite`, published as an artifact,
  and consumed by every shard (`VSIX_SUITE_PREBUILT=1`). The VS Code test host
  download is cached per runner OS. A shard that recompiles multiplies minutes
  of identical work by the width of the matrix.
- **A shard MUST NOT verify the VSIX payload.** That is one production esbuild
  and a `vsce ls` per shard for an answer that cannot vary by shard — and it
  leaves the PRODUCTION bundle in `dist/`, whose missing sourcemap strips the
  end-to-end coverage the shard exists to collect. Each platform's PHASE 2 build
  verifies the payload once, as its last step, so a `.vscodeignore` mistake is
  reported in minutes rather than behind the test matrix.
- **Shard tracefiles are repo-relative.** `_test-vsix-shard` writes
  `target/coverage-vsix-shard-<platform>-<chunk>.lcov` through
  `tools/coverage/relativize-lcov.mjs`. c8 records absolute paths, so without
  this the same source file keys twice in the union — once under
  `C:\Code\SharpLsp\...` and once under `/home/runner/...` — doubling the
  denominator and failing the gate for a reason unrelated to coverage.
- **One editor start per workspace SHAPE.** Most suites run in the fixture
  folder; suites under `src/test/suite/multiroot/` need a workspace OPENED with
  two folders, because adding a second folder from inside the test host turns
  the window into a workspace and VS Code restarts the extension host running
  the suite. `.vscode-test.mjs` therefore declares a second configuration that
  opens a freshly generated two-folder `.code-workspace` and names its shape in
  `SHARPLSP_WORKSPACE_SHAPE`; `src/test/suite/index.ts` runs only the suites of
  the shape it was started for. The second start happens only when the run
  selects a multi-root suite, so a chunk without one pays nothing, and both
  starts instrument into ONE coverage directory, so a shard still writes one
  tracefile.
- **Local runs stay unsharded.** `make test` / `make _test-vsix` remain the
  single-invocation, inline-gate path; sharding is a CI wall-clock concern only.

### [DIST-CI-VSIX-COVERAGE] The VS Code Coverage Gate

There is exactly ONE coverage gate for the extension, it runs at the END of the
pipeline, and it ratchets the union of every instrumented shard on every
platform (`ci-coverage.yml`, PHASE 5, `needs: [test-rust, test-vsix, test-vsix-windows]`).

Invariants:

- **No leg gates on its own.** A single chunk cannot meet the line threshold, so
  a per-leg gate can only be wrong. `_gate-vsix-coverage` union-merges every
  `target/coverage-vsix-shard-*.lcov` with the same
  `tools/coverage/merge-lcov.mjs` the Rust shards use ([DIST-CI-RUST-SHARDS])
  and enforces the identical ratchet ([DIST-CI-COVERAGE-THRESHOLDS]).
- **The union is sound.** Every shard instruments the same bundle, so a file
  loaded by any shard contributes its whole line set (unexecuted lines as
  `DA:<line>,0`); summing hit counts per (file, line) reproduces the line
  percentage of one unsharded run.
- **The denominator MUST NOT move.** Coverage runs with `includeAll` off.
  Enabling it would change the file set and silently move the ratchet.
- **A missing shard fails the gate.** A shard that fails uploads no tracefile,
  so the union shrinks and the ratchet catches it. Coverage is never computed
  from "whatever shards happened to finish".

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

## [DIST-CI-COVERAGE-THRESHOLDS] Coverage Thresholds

`coverage-thresholds.json` at the repository root is the single source of truth
for coverage floors: one line-coverage `threshold` per measured project under
`projects`, falling back to `default_threshold`.
`tools/coverage/check-coverage.mjs <project> <percent>` (or
`--json <file> <dotted.path>`) gates each project INDEPENDENTLY, so no roll-up can
hide one project behind another.

1. **Ratchet only.** A threshold lower than the one committed at the merge base
   with `main` fails outright, whatever the measurement.
2. **Tolerance.** A measurement fails below the threshold minus one percentage
   point, so run-to-run noise does not fail a PR that changed nothing.
3. **Raising.** A measurement above the threshold raises it to the measurement
   minus that point, rewriting the file whole (temp file, then rename). The raise
   lands through the reviewed PR diff, never a bot commit ([DIST-CI-LAYOUT]).
4. **Where each number comes from.** `sharplsp` (Rust) is the union of the shard
   tracefiles ([DIST-CI-RUST-SHARDS]); each sidecar project is its merged
   Cobertura report (`tools/coverage/merge-cobertura.cs`, with the exclusions of
   `.config/coverage/coverlet.runsettings`); `vscode-extension` is the union of
   every VS Code shard on both platforms ([DIST-CI-VSIX-COVERAGE]);
   `sharplsp-zed` and `sharplsp-rider` come from their own legs
   ([DIST-CI-EDITORS]).

## [DIST-CI-EDITORS] Editor Integration Tests

`ci-test-editors.yml` (PHASE 4) tests the two editor integrations that ship
outside the VSIX. Both shipped for most of their history with no CI job at all:
the Zed extension's unit tests were compiled but never executed, and the Rider
plugin had a configured JUnit harness and was not even compiled on a PR.

Neither consumes a PHASE 2 artifact, because neither links against one: the Zed
extension is its own Cargo workspace, shipped as `wasm32-wasip1`, and the Rider
plugin is a Kotlin/IntelliJ build. Each compiles its own instrumented tests, and
each gates inside its own job, because neither suite is sharded and each
tracefile is complete there ([DIST-CI-COVERAGE-THRESHOLDS]).

- **Zed.** `make _test-zed` runs the extension's unit tests for the host target
  under `cargo llvm-cov` and gates `sharplsp-zed`. The root workspace's coverage
  run cannot see this workspace, so it needs its own gate.

### [DIST-CI-RIDER] Rider Plugin Tests

`make _test-rider` runs the plugin's JUnit suite under Kover (`koverXmlReport`),
reads the roll-up line percentage with `tools/coverage/kover-line-percent.cs` —
the report's own totals, never one class's counters — and gates `sharplsp-rider`.

1. **One JDK resolver.** Every Rider make target runs Gradle through
   `tools/rider/gradle.sh`, which finds a JDK 21+ (Rider 2026.1 runs on
   JetBrains Runtime 21) even when an older JDK is first on `PATH`: `JAVA_HOME`
   first, then the Windows install locations, `/usr/lib/jvm`, and on macOS
   `/Library/Java/JavaVirtualMachines` and both Homebrew prefixes
   (`/opt/homebrew/opt/openjdk*`, `/usr/local/opt/openjdk*`, at the keg's
   `libexec/openjdk.jdk/Contents/Home`). `/usr/libexec/java_home` is never asked:
   it cannot see Homebrew JDKs, and asked for 21 it answers with a 17 and exits 0.
   `gradle.sh --jdk` prints the JDK a build would use.
2. **Never a silent skip.** In CI, `RIDER_REQUIRED=1` turns "no JDK 21+" into a
   failure: a skipped gate that reports green is worse than none. The release's
   `build-rider` job runs the same way ([DIST-RIDER-RELEASE]). Locally the task
   skips, but records itself in `target/skipped-legs`, and `make test` and
   `make ci` end by listing every recorded leg instead of a bare "passed"; a run
   clears its own record. `_test-rider` deletes the previous Kover report first,
   so a skipped run can never be gated on an old one.
3. **The shippable zip is built too.** The same job runs `make _build-rider`,
   reusing the Gradle daemon and the IntelliJ Platform SDK it already resolved,
   so a Kotlin break cannot reach `main` behind a green pipeline. The multi-GB
   SDK download is cached, keyed on the Gradle build files.
4. **The resolver is tested.** `tools/rider/gradle.test.mjs` (in
   `make _test-tooling`) hands the script a fixture machine through
   `RIDER_JDK_SYSROOT`, so the runner's own JDKs cannot decide the result. It
   covers the Homebrew, Intel-Homebrew and `/Library` locations, a `JAVA_HOME`
   that is too old and one that wins, a JDK below 21 never being chosen, and a
   machine with none: a visible, recorded skip, and a failure under
   `RIDER_REQUIRED`.
