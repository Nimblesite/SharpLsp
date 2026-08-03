# [DIST-SPEC] Distribution Specification

This is the normative specification for SharpLsp distribution.

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
| Source | `Samsung/netcoredbg`, pinned to `3.2.0-1092`, MIT-licensed |
| Staging | `tools/vsix/fetch-netcoredbg.sh <platform>` downloads and extracts the upstream archive into `bin/<platform>/netcoredbg/` without retaining a download memo; wired into `_stage-vsix-binary-only` and `_package-vsix` in the Makefile |
| Layout | `bin/<platform>/netcoredbg/netcoredbg[.exe]` **plus** its sibling managed assemblies (`ManagedPart.dll`, `dbgshim.dll`, `Microsoft.CodeAnalysis*.dll`) — the whole directory ships, since the executable loads them |
| Resolution | `getNetcoredbgCandidates(extensionPath)` prefers the bundled binary; scan order is user-setting (`sharplsp.debug.netcoredbgPath`) → **bundled** → common install paths → `PATH` |
| Platform coverage | Upstream ships prebuilt binaries for `win32-x64`, `linux-x64`, `linux-arm64`, `darwin-arm64` only. On `win32-arm64` and `darwin-x64` the VSIX cannot bundle netcoredbg; debugging falls back to a `PATH` copy / the setting. The fetch script skips those platforms cleanly (exit 0). |

Unlike the three [DIST-COMPONENTS], a missing netcoredbg degrades **only** the debugging feature (surfaced via an error toast pointing at the install), not whole-extension activation.

**Licensing.** netcoredbg (MIT, © 2017 Samsung Electronics Co., LTD) and every other bundled third-party component are acknowledged in [THIRD-PARTY-NOTICES.md](../../THIRD-PARTY-NOTICES.md); all bundled licenses are permissive and compatible with SharpLsp's MIT license. Bumping the pinned netcoredbg version MUST update `tools/vsix/fetch-netcoredbg.sh` and the notices file in lockstep.

## [DIST-RUNTIME-ACQUIRE] .NET SDK Acquisition

The framework-dependent `net10.0` sidecars require a .NET 10 SDK, not merely a runtime. The C# sidecar performs an in-process MSBuild design-time build and `MSBuildLocator.QueryVisualStudioInstances(options)` enumerates installed SDKs; a runtime-only or older-SDK machine cannot provide matching MSBuild/Roslyn and project load fails with `FUSION_E_REF_DEF_MISMATCH` or no MSBuild. SharpLsp therefore acquires the SDK through Microsoft's [`ms-dotnettools.vscode-dotnet-runtime`](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.vscode-dotnet-runtime) extension. See `src/sidecars/SharpLsp.Sidecar.CSharp/MSBuildInstanceSelector.cs` and [DIST-SDK-DISCOVERY].

> The .NET Install Tool exposes `dotnet.acquire` for a local runtime, `dotnet.acquireGlobalSDK` for a system-wide SDK, and `dotnet.findPath` for discovery. Its API contract is documented at <https://github.com/dotnet/vscode-dotnet-runtime/blob/main/Documentation/commands.md>.

**Hard rules:**

1. SharpLsp's [src/editors/vscode/package.json](../../src/editors/vscode/package.json) MUST declare `"extensionDependencies": ["ms-dotnettools.vscode-dotnet-runtime"]`. VS Code installs declared dependencies silently when SharpLsp is installed — no user prompt.
2. SharpLsp MUST explicitly activate the .NET Install Tool extension (`vscode.extensions.getExtension(...).activate()`) before invoking its commands. `extensionDependencies` activates it first, but the explicit await turns a missing/disabled dependency into a clear `[DIST-FAILURE-UX]` message instead of an opaque "command `dotnet.findPath` not found".
3. On every activation SharpLsp MUST call the `dotnet.acquireGlobalSDK` command exposed by the .NET Install Tool with the parameter shape mandated in [DIST-API-PARAMETERS]. The command returns `{ dotnetPath: string }` pointing at the `dotnet` executable of a system-wide SDK install. A global SDK install runs the platform installer and **may prompt for elevation** — that UI belongs to the .NET Install Tool, and is the unavoidable cost of providing MSBuild; SharpLsp never shows the elevation prompt itself.
4. Before `dotnet.acquireGlobalSDK`, SharpLsp MUST call `dotnet.findPath` with `mode: 'sdk'` and `versionSpecRequirement: 'greater_than_or_equal'` to skip acquisition when the user already has a compatible SDK (>= 10.0). The path returned by either call is the SDK SharpLsp uses.
5. SharpLsp MUST set `DOTNET_ROOT` (the directory of `dotnetPath`) on the environment passed to the Rust LSP host so all spawned sidecars run on that SDK's runtime and so `MSBuildLocator` finds that SDK's MSBuild.

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
3. **SDK-registration failure MUST degrade, never crash.** Neither discovery nor registration may take the sidecar down: on any failure it logs one actionable hint and leaves MSBuild unregistered. The process MUST still reach `READY` and serve MSBuild-free requests (`solution/read`, `ping`, `shutdown`). Roslyn-backed handlers then fail per-request with a clear error rather than the whole sidecar crash-looping. This is a specialization of [DIST-FAILURE-UX] for the sidecar process.

The one-shot startup hint emitted on the degraded path is a sanctioned sidecar stderr write per [DIST-CLEAN-OUTPUT] (alongside the Roslyn-mismatch hint) — it is actionable, level-appropriate, and fires at most once per process, never per request.

**Implementation reference:**
- `src/sidecars/SharpLsp.Sidecar.CSharp/MSBuildInstanceSelector.cs` — `QueryInstalledSdks` (explicit `DiscoveryType.DotNetSdk` + neutral `WorkingDirectory`), `NewestInstancePath` fallback, `BuildDiscoveryFailedHint`; `Register` no longer calls `RegisterDefaults()`.
- `src/sidecars/SharpLsp.Sidecar.CSharp/Program.cs` — MSBuild registration failure logs and continues instead of `Environment.Exit(1)`.
- `src/sidecars/SharpLsp.Sidecar.CSharp.Tests/GlobalJsonSdkPinEndToEndTests.cs` — spawns the real sidecar apphost with a workspace whose `global.json` pins an uninstalled SDK and asserts it reaches `READY` and serves `solution/read`.

## [DIST-API-PARAMETERS] .NET Install Tool Parameters

Every call SharpLsp makes to the .NET Install Tool MUST include all four required fields in the `IDotnetAcquireContext`:

```ts
{
  version: '10.0',                     // major.minor only — the docs require this exact format
  mode: 'sdk',                         // 'runtime' | 'sdk' | 'aspnetcore' — SharpLsp needs 'sdk' for MSBuild
  architecture: dotnetArchitecture(),  // 'x64' | 'arm64' | 'x86' — derived from process.arch
  requestingExtensionId: 'nimblesite.sharplsp',
  installType: 'global',               // required by dotnet.acquireGlobalSDK; omit for dotnet.findPath
}
```

`dotnet.findPath` takes the same four required fields nested under `acquireContext` (no `installType`), plus `versionSpecRequirement: 'greater_than_or_equal'`. `dotnet.acquireGlobalSDK` takes them flat, plus `installType: 'global'`.

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
6. **Recovery commands MUST be registered** so the user can re-attempt without uninstalling. Examples: `sharplsp.retryDotnetAcquisition`, `sharplsp.restartServer`. These appear in the command palette under the `SharpLsp:` category.

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

**Implementation reference:**
- `src/sharplsp/src/main.rs` — `IsTerminal`-gated `.with_ansi(…)` on the stderr `tracing` layer.
- `src/editors/vscode/src/output-filter.ts` — `stripAnsi` + `createAnsiStrippingChannel`, wired into the client's `outputChannel` in `src/editors/vscode/src/client.ts`.
- `src/sidecars/SharpLsp.Sidecar.Common/Logging/SidecarLog.cs` — Serilog rolling-file configuration + `CollapseRepeatedLines`; initialized by `SidecarHost`.
- `src/sidecars/SharpLsp.Sidecar.CSharp/Workspace/WorkspaceManager.cs` — `LogWorkspaceFailure` collapses and de-duplicates MSBuild workspace-load diagnostics.

## [DIST-VSIX-MODEL] VSIX Distribution Model

The VSIX is self-contained. A user who installs the extension gets everything they need with zero additional installation steps beyond the .NET 10 SDK (which is acquired automatically per [DIST-RUNTIME-ACQUIRE]).

- `sharplsp` — native Rust binary, pre-built per platform, bundled at `bin/<platform>/`
- `sharplsp-sidecar-csharp` — framework-dependent .NET assembly, bundled at `bin/all/`
- `sharplsp-sidecar-fsharp` — framework-dependent .NET assembly, bundled at `bin/all/`

**No component is ever installed via `dotnet tool install`, package manager, or any mechanism outside the VSIX.** The `dotnet-tool` source type is NOT used for VSIX distribution.

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

## [DIST-VSIX-ASSET-INTEGRITY] VSIX Asset Integrity

The extension's icon assets in `src/editors/vscode/icons/` are symlinks into `docs/designs/logo/`. With `core.symlinks=false`, Git materializes target paths as text files, which `vsce` would package as broken icons.

1. Every image asset referenced by the extension manifest MUST be packaged as real image content. A VSIX containing symlink text stubs is broken.
2. `tools/vsix/resolve-symlink-stubs.mjs` rewrites stub files in place with their target's content. It MUST leave real OS symlinks untouched (macOS/Linux, and Windows checkouts with `core.symlinks=true`), making it a cross-platform no-op wherever symlinks work. It only rewrites plain files whose entire content is a relative POSIX path resolving to an existing file.
3. The resolver MUST run automatically before packaging (`vscode:prepublish`) and before the e2e suite (`pretest`), so both the packaged VSIX and the extension-development host load real images. The e2e suite asserts the invariant (`bundled-binary.test.ts`).
4. Resolved stubs modify the working tree and MUST NOT be committed — Git would record the binary content as the symlink's target text, corrupting the symlink for every other platform. Restore with `git restore src/editors/vscode/icons`.

## [DIST-RESOLUTION] Binary Resolution

Resolution is driven by the `sources` array per component in `shipwright.json`. The `activateDeploymentToolkit` call verifies all three on activation. Failure to resolve any required component triggers [DIST-FAILURE-UX] (degraded mode + toast), not a host-crashing throw.

### [DIST-RESOLUTION-LSP] LSP Host

`sharplsp` (LSP server — native binary).

Sources: `["user-setting", "env", "bundled", "path", "pkgmgr"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.lspPath` VS Code setting — absolute path; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_LSP_PATH` (full path) or `SHARPLSP_BINARY_DIR` (directory); version drift = `ok-with-warning` |
| 3 | **`bundled`** | `bin/<platform>/sharplsp[.exe]` inside `extensionPath` ← **DEFAULT for all users** |
| 4 | `path` | `sharplsp` on `$PATH`; exact version match required |
| 5 | `pkgmgr` | Shows modal prompt: `brew install nimblesite/tap/sharplsp` / `scoop install nimblesite/sharplsp` |

### [DIST-RESOLUTION-CSHARP] C# Sidecar

`sharplsp-sidecar-csharp` (C# Roslyn sidecar — .NET assembly).

Sources: `["user-setting", "env", "bundled", "path"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.csharpSidecarPath` VS Code setting; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_CSHARP_SIDECAR_PATH` (full path) |
| 3 | **`bundled`** | `bin/all/sharplsp-sidecar-csharp` inside `extensionPath` ← **DEFAULT for all users** |
| 4 | `path` | `sharplsp-sidecar-csharp` on `$PATH`; exact version match required |

**If bundled binary is missing the VSIX is broken — fix the build, not the resolution.** Surface per [DIST-FAILURE-UX].

### [DIST-RESOLUTION-FSHARP] F# Sidecar

`sharplsp-sidecar-fsharp` (F# FCS sidecar — .NET assembly).

Sources: `["user-setting", "env", "bundled", "path"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.fsharpSidecarPath` VS Code setting; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_FSHARP_SIDECAR_PATH` (full path) |
| 3 | **`bundled`** | `bin/all/sharplsp-sidecar-fsharp` inside `extensionPath` ← **DEFAULT for all users** |
| 4 | `path` | `sharplsp-sidecar-fsharp` on `$PATH`; exact version match required |

**F# is first-class. No SharpLsp without F# support. If bundled binary is missing the VSIX is broken — fix the build.** Surface per [DIST-FAILURE-UX].

## [DIST-VERSION-MATCH] Version Mismatch Behavior

| Source | Version mismatch behaviour |
|---|---|
| `user-setting` | Hard error — surfaced via [DIST-FAILURE-UX], degraded mode |
| `env` | `ok-with-warning` — activation continues |
| `bundled` | `ok-with-warning` — activation continues |
| `path` | Skipped (no match) — falls through to next source |

## [DIST-VERSION-INVARIANT] Release Version Invariant

`Cargo.toml` `version` is the single source of truth. The release workflow stamps the tag version into `Cargo.toml` and `src/editors/vscode/package.json`, commits and pushes those changes, then builds all artifacts from that commit. Sidecar versions are set via `-p:PackageVersion` at publish time.

All versions MUST match byte-for-byte for a release to be valid.

## [DIST-VERSION-OUTPUT] Version Command Output

| Binary | Expected stdout |
|---|---|
| `sharplsp --version` | `sharplsp <semver>` |
| `sharplsp-sidecar-csharp --version` | `sharplsp-sidecar-csharp <semver>` |
| `sharplsp-sidecar-fsharp --version` | `sharplsp-sidecar-fsharp <semver>` |

The first whitespace-delimited token MUST exactly match the component `id` in `shipwright.json`.

## [DIST-EDITOR-CONTRACT] Editor Activation Contract

The VS Code extension uses `@nimblesite/shipwright-vscode` (`activateDeploymentToolkit`) to resolve all three components. The extension MUST:

1. **Never hand-roll binary resolution** — use `activateDeploymentToolkit` exclusively.
2. **Never download binaries over HTTPS** — all binaries ship in the VSIX, except .NET 10 itself which is acquired via the .NET Install Tool extension (see [DIST-RUNTIME-ACQUIRE]).
3. **Never treat any sidecar as optional** — both sidecars are required, both crash activation if missing.
4. **Surface every failure per [DIST-FAILURE-UX]** if any component returns `status: "error"`. The .NET 10 SDK is NOT a bundled component; failure to acquire it enters degraded mode per [DIST-RUNTIME-ACQUIRE].
5. **Pass the Shipwright-resolved path** to `LanguageClient` — never hardcode a binary path.
6. **Acquire the .NET 10 SDK at activation start** via `dotnet.acquireGlobalSDK` from the .NET Install Tool extension (see [DIST-RUNTIME-ACQUIRE]). Show a non-interactive progress notification + status-bar spinner. SharpLsp's own UI never prompts or blocks on user action.
7. **Use `Result<T, E>` everywhere** per [DIST-FAILURE-UX]. No `throw` inside extension code; no unhandled rejections out of `activate()`.

## [DIST-WORKSPACE-TRUST] Workspace Trust

An untrusted workspace MUST NOT select an executable or inject process arguments. `src/editors/vscode/package.json` declares `capabilities.untrustedWorkspaces.supported: "limited"` and restricts `sharplsp.lspPath`, `sharplsp.csharpSidecarPath`, `sharplsp.fsharpSidecarPath`, `sharplsp.server.extraArgs`, `sharplsp.fsi.extraArgs`, and `sharplsp.debug.netcoredbgPath`.

While `workspace.isTrusted` is false, the runtime guards in `src/editors/vscode/src/config.ts` MUST return no custom LSP path, server arguments, or FSI arguments, leaving Shipwright's bundled binaries in use. When `workspace.onDidGrantWorkspaceTrust` fires, `src/editors/vscode/src/extension.ts` MUST restart the language client so newly trusted path and argument settings take effect without a window reload.

## [DIST-PATH-INSTALL] PATH Installation

Users who want `sharplsp` on their system PATH outside VS Code may install via:

- **macOS/Linux**: `brew install nimblesite/tap/sharplsp`
- **Windows**: `scoop install nimblesite/sharplsp`

This is entirely optional. The bundled VSIX binary is sufficient for VS Code users.

## [DIST-RELEASE] Release Workflow

Tag-triggered (`v*`). Jobs:

1. **`build-sharplsp`** — matrix: 6 targets (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64, win32-arm64). Produces one native binary per platform.
2. **`publish-sidecars`** — single ubuntu job. `dotnet publish --no-self-contained` both sidecars. Produces the `bin/all/` assemblies staged for VSIX inclusion.
3. **`build-vsix`** — for each platform: stages `bin/<platform>/sharplsp[.exe]` + `bin/all/sharplsp-sidecar-*`, runs `vsce package --target <platform>`. Produces 6 per-platform `.vsix` files, each fully self-contained.
4. **`release`** — creates GitHub release with all archives and VSIXs, updates Homebrew tap, updates Scoop bucket, publishes VSIXs to VS Code Marketplace.

## [DIST-CI-LAYOUT] CI Workflow Layout

The PR pipeline uses reusable workflows (`on: workflow_call`):

| Workflow | Leg |
|---|---|
| `ci.yml` | Orchestrator: `detect-changes`, dependency review, manifest validation, and one `uses:` job per leg |
| `ci-lint.yml` | Rust / Zed / .NET / VS Code lint + format gates |
| `ci-rust.yml` | Sharded Rust e2e suite ([DIST-CI-RUST-SHARDS]), the union coverage gate, the version contract |
| `ci-dotnet.yml` | Sidecar tests (Ubuntu) + win32 named-pipe transport ([DIST-CI-WIN-TRANSPORT]) |
| `ci-vsix.yml` | Full VS Code suite + coverage gate (Ubuntu) |
| `ci-vsix-windows.yml` | VS Code feature chunks on Windows ([DIST-CI-WIN-VSIX]) |

Invariants:

- **`detect-changes` is the only gate.** Every leg is `needs: detect-changes` and guarded by `code_changed`; no leg `needs:` another. Lint and tests are independent required gates — serializing tests behind lint added ~3 minutes to every PR's critical path, and a lint failure still blocks the merge.
- **Legs are called, never duplicated.** Shared VSIX shell logic lives in `tools/vsix/` (for example `purge-path-binaries.sh` and `vsix-test-chunks.mjs`) and shared build logic in the `Makefile`, so a step is written once and called from every workflow that needs it.

### [DIST-CI-SECURITY] Security Gates

[ci.yml](../../.github/workflows/ci.yml) MUST run dependency review for pull requests. [codeql.yml](../../.github/workflows/codeql.yml) MUST scan pull requests, weekly schedules, and tagged releases; `release.yml` calls it with `gate: true`, and any high or critical finding blocks release and publication. Workflow permissions default to `contents: read`; only jobs that publish security events or artifacts receive narrower write permissions.

## [DIST-CI-NODE] Node.js Toolchain

**Minimum: Node.js 20.x.x.** This is the minimum required by `@vscode/vsce` v3.x.

Ground truth: <https://github.com/microsoft/vscode-vsce>

All CI jobs that run `vsce package` or `vsce publish` MUST use `node-version: '20'` or higher. Do not upgrade beyond what vsce requires without checking the above URL first.

## [DIST-CI-DOTNET] .NET Toolchain

**Required: .NET 10.** All sidecar publish steps use `dotnet publish --no-self-contained` targeting `net10.0`.

### [DIST-CI-DOTNET-DEPSFILE] Dependency File Generation

`src/sidecars/SharpLsp.Sidecar.Common/SharpLsp.Sidecar.Common.csproj` is a referenced-only class library and MUST set `<GenerateDependencyFile>false</GenerateDependencyFile>`. Its consumers generate their own runtime dependency files; emitting the unused `SharpLsp.Sidecar.Common.deps.json` lets concurrent builds or indexers lock the shared `bin/` artifact and fail `GenerateDepsFile` with MSB4018. `src/sharplsp/tests/build_deps_file_e2e.rs` MUST verify the evaluated MSBuild property, not project-file text (GitHub #111).

## [DIST-CI-RUST] Rust Toolchain

Stable toolchain. Cross-compilation targets must be added via `dtolnay/rust-toolchain@stable` with explicit `targets:`.

### [DIST-CI-RUST-SHARDS] Rust Test Shards

The Rust e2e suite runs single-threaded (`RUST_TEST_THREADS=1` — tests spawn real Roslyn/FCS sidecars), so its wall time scales with test count, not runner cores. CI therefore splits it into `SHARD_COUNT` nextest **hash partitions** (`make _test-rust-shard SHARD=<n>`, i.e. `--partition hash:<n>/<count>`), run as a `test-rust` job matrix.

Invariants:

- **Same tests, same serialization.** A shard changes only *which* slice of the suite runs, never how: `--no-fail-fast` and the `--test-threads` serialization apply to every shard. Sharding MUST NOT skip, filter, or reorder tests beyond the partition itself.
- **One gate, over the union.** Each shard exports lcov (`target/coverage-rust-shard<n>.lcov`). No shard can meet the line threshold alone, so no shard runs the coverage gate; the `coverage-rust` job union-merges the tracefiles (`tools/coverage/merge-lcov.mjs`) and enforces the identical `tools/coverage/check-coverage.sh` ratchet a single-job run enforces. Every shard tracefile carries the full instrumented line set (unexecuted lines as `DA:<line>,0`), so the union reproduces exactly the line percentage of an unsharded run.
- **Local runs stay unsharded.** `make test` / `make _test-rust` remain the single-invocation JSON + inline-gate path; sharding is a CI wall-clock concern only.
- **Version contract is its own job.** The `--version` contract checks ([DIST-VERSION-OUTPUT]) run in the `version-contract` job: the release-profile build shares no artifacts with the instrumented test build, so bundling it into a test job serializes it onto the critical path for zero reuse.

## [DIST-CI-WIN-TRANSPORT] Windows Sidecar Transport

`tokio::net::UnixStream` is **unix-only** and MUST NOT be used unconditionally. All sidecar transport code MUST be gated:
- `#[cfg(unix)]` — use `tokio::net::UnixStream`
- `#[cfg(windows)]` — use `tokio::net::windows::named_pipe`; TCP loopback is not an IPC fallback

Both the Rust host and the .NET sidecar MUST use the same transport on each platform. Win32 builds failing to compile due to `UnixStream` is a hard blocker.

The .NET sidecars are platform-neutral assemblies shipped identically in every VSIX ([DIST-VSIX-LAYOUT]), so **their transport selection MUST be a runtime decision keyed on the endpoint shape**: an endpoint starting with `\\.\pipe\` selects a named pipe server/client; anything else selects a Unix domain socket. Compile-time gating (`#if WINDOWS`) is forbidden in sidecar transport code — the symbol is never defined for the platform-neutral `net10.0` build, which silently compiles the Unix branch into the Windows VSIX and makes the sidecars exit before READY (GitHub #110).

Both listener flavors MUST restrict the endpoint to the current user: `0600` on the Unix domain socket, `PipeOptions.CurrentUserOnly` on the named pipe server. Endpoint names MUST also be unpredictable and unique per spawn per [SIDECAR-STARTUP-ENDPOINT](SIDECAR-LIFECYCLE-SPEC.md), preventing concurrent hosts or an orphaned prior generation from intentionally sharing a name. Current-user restriction remains mandatory defense in depth. CI MUST run the sidecar transport tests on a Windows runner—an Ubuntu-only matrix never executes the named-pipe arm, which is how GitHub #110 shipped.

## [DIST-CI-WIN-VSIX] Windows VS Code End-to-End Tests

CI MUST run the VS Code end-to-end suite's whole feature surface on Windows runners through `ci-vsix-windows.yml` and `_test-vsix-win`: the release-built `sharplsp` host, Roslyn and FCS sidecars, actual VS Code extension host, and win32 named-pipe IPC. [DIST-CI-WIN-TRANSPORT] covers frames only, while Windows-specific executables (`netcoredbg.exe`, `dotnet-trace`, `dotnet test`, `dotnet new`) and paths require full feature coverage; a grep-selected smoke subset is insufficient.

The suite is sliced into **feature chunks**, one Windows CI job each, run with `fail-fast: false` so one failing feature area never hides the state of the others:

| Chunk | Feature surface |
|---|---|
| `lifecycle` | Activation, configuration, bundled binary/sidecar resolution, client lifecycle + restart, cross-cutting command workflows |
| `lsp` | C# intelligence over the real LSP: completion, hover, diagnostics, document symbols, folding, selection ranges, code actions, document sync, client lifecycle |
| `fsharp` | The whole F# LSP surface — navigation, intelligence, syntax, diagnostics, code fixes, hierarchy, workspace symbol (F# is a first-class citizen, so it is gated on Windows in full, not sampled) |
| `debug` | Debugging: launch/attach configuration resolution, the `netcoredbg` adapter factory, `sharplsp.debugProgram` against real projects, plus Test Explorer discovery/run/debug and the test-status CodeLens |
| `profiler` | Profiling: `dotnet-trace` sessions, live counters, memory dumps, `.nettrace` conversion, profiler webviews — plus FSI, build, output filtering and hot reload |
| `explorer` | Solution Explorer tree, reactive sort/state signals, tooltips and reveal, the full context-menu surface, project-dependency watcher |
| `packages` | Scaffolding (create solution/project) and the NuGet surface: browser panel, search/add/update/restore, real `.csproj` dependency edits |

Invariants:

- **One declaration.** Chunk membership lives in `src/editors/vscode/test-chunks.json` and is read by `tools/vsix/vsix-test-chunks.mjs` (`files <chunk>` → `MOCHA_FILES` globs, `matrix` → the CI job matrix, `check` → the completeness guard). It MUST NOT be duplicated into CI YAML.
- **Nothing escapes.** `make _lint-vsix` runs `vsix-test-chunks.mjs check`, which fails if any `*.test.ts` suite is claimed by no chunk or by more than one. A new suite is therefore gated on Windows by default; opting out requires an explicit entry under `excluded` with a written reason.
- **Selection is by file, not by title.** The inner mocha runner selects suites via the `MOCHA_FILES` glob list. Title-regex selection (`MOCHA_GREP`) is a local debugging aid only — it silently drops tests when a suite is renamed. A glob matching zero compiled suites is a hard error, so a mistyped chunk fails instead of reporting a green run of nothing.
- **Build once, fan out.** A single `build` job compiles the Rust host and both sidecars and publishes them as an artifact; each chunk job downloads and stages them (`_stage-vsix-binary-only`). Rebuilding per chunk would cost one cold Windows Rust build per feature area.
- **Ubuntu owns coverage.** Windows chunks run **without** `--coverage` and enforce no coverage gate — one chunk can never meet the line threshold. The Ubuntu `test-vsix` job owns the full single-process run plus the ratcheted gate, and is the only job that runs the `real-repo-*` stress suites (each clones and restores a pinned third-party repository; that is repo ingestion, not platform behaviour).
- **No PATH leakage.** Every VS Code job runs `tools/vsix/purge-path-binaries.sh` first, so the test host can only resolve the freshly-staged bundled binaries. A dev copy on `PATH` would substitute itself for the artifact under test and turn a broken bundle green.

- **Compare paths case-insensitively on Windows.** VS Code lowercases the drive letter whenever a path travels through `Uri.fsPath`, while `extensionPath` and `os.tmpdir()` preserve the original casing, so the same file legitimately has two spellings. Any assertion comparing a `Uri`-derived path against a directly-constructed one MUST go through `comparablePath()` (`test-helpers.ts`), which lowercases on win32 only — POSIX paths stay case-sensitive, because there `/tmp/A` and `/tmp/a` really are different files.
- **Suites MUST be order-independent.** Chunking changes which suites share an extension host, so no suite may depend on state another suite left in a shared singleton. Fixture identifiers that feed a shared registry — notably test method names discovered into the `SharpLspTestController` — MUST be unique per suite, or a test asserting "nothing matches" passes or fails on whichever suite's discovery won the race.

The LSP e2e temp-dir helper MUST fall back to `os.tmpdir()` (never a hardcoded `/tmp`) so these suites run on Windows.

## [DIST-SECRETS] Publishing Credentials

The VS Code Marketplace publishes **passwordless via Microsoft Entra ID OIDC** (workload identity federation) — there is **no** long-lived Marketplace PAT. The `release.yml` `publish-marketplace` job runs in the `release` GitHub Environment so its OIDC subject is the deterministic `repo:Nimblesite/SharpLsp:environment:release`, which one Entra federated credential trusts. Open VSX has **no** OIDC/trusted-publishing path (verified 2026), so it still requires a long-lived access token.

| Secret / Variable | Scope | Purpose |
|---|---|---|
| `BREW_SCOOP_PAT` | repo | PAT with `contents:write` on `Nimblesite/homebrew-tap` and `Nimblesite/scoop-bucket` |
| `AZURE_CLIENT_ID` | `release` env | Entra ID app (client) id — Marketplace OIDC publish. Not sensitive; no PAT involved. |
| `AZURE_TENANT_ID` | `release` env | Entra ID tenant (directory) id — Marketplace OIDC publish. |
| `OPEN_VSX_PAT` | repo | Open VSX access token. No OIDC path exists; long-lived token required (rotate on a schedule — post-2025 tokens expire by default). |

## [DIST-CI-SMOKE] CI Smoke Checks

Every PR:
- Validates `shipwright.json` with `shipwright-validate-manifest`
- Runs `dotnet publish --no-self-contained` on both sidecars
- Verifies `bin/<platform>/sharplsp[.exe]` exists in the staged VSIX layout
- Verifies `bin/all/sharplsp-sidecar-csharp` exists in the staged VSIX layout
- Verifies `bin/all/sharplsp-sidecar-fsharp` exists in the staged VSIX layout
- Runs `sharplsp --version`, `sharplsp-sidecar-csharp --version`, `sharplsp-sidecar-fsharp --version`

## [DIST-FORBIDDEN] Forbidden Distribution Patterns

- `https.get(...)` / `fetch(...)` / `child_process` spawning for downloading any binary, including .NET. The .NET runtime is delegated exclusively to the .NET Install Tool extension (see [DIST-RUNTIME-ACQUIRE]); other binaries ship in the VSIX.
- `dotnet tool install` / `dotnet tool update` as a distribution mechanism for VSIX users.
- Treating either sidecar as optional — both are required, both surface a degraded-mode toast if missing.
- Writing any component binary into `~/.local/`, temp dirs, or paths not managed by Shipwright or the .NET Install Tool.
- Hand-rolling binary resolution — use `activateDeploymentToolkit` exclusively.
- Hand-rolling .NET runtime acquisition — `dotnet.acquire` from the .NET Install Tool is the only sanctioned mechanism.
- Calling the .NET Install Tool without **all four required fields** of `IDotnetAcquireContext` (`version`, `mode`, `architecture`, `requestingExtensionId`) — see [DIST-API-PARAMETERS].
- Skipping version verification on activation.
- Shipping a single universal VSIX containing all platform binaries.
- Modal prompts, dialogs, or any UI that *requires* user action during .NET runtime acquisition. The user must be informed (progress notification + status bar) but never asked to do anything.
- **`throw` inside extension code, or any code path that allows `activate()` to reject** — see [DIST-FAILURE-UX]. Use `Result<T, E>` and surface a non-modal toast.
- **Failing silently when activation cannot deliver a language server** — every failure mode MUST produce a visible notification with at least a `[Show Log]` action and a recovery command in the palette.
