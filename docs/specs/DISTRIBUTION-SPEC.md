# Distribution Specification

This document is the canonical specification for how SharpLsp is distributed.
All statements below are normative requirements, not suggestions.

Every section has a hierarchical ID per CLAUDE.md (`[GROUP-TOPIC]` /
`[GROUP-TOPIC-DETAIL]`, uppercase, hyphen-separated, never numbered). Code
that implements a section MUST reference its ID in a comment. Cross-references
inside this spec MUST use IDs, never numbers.

## [DIST-COMPONENTS]

SharpLsp has three executable components. All three are REQUIRED and MUST be bundled in the VSIX. Missing any one of them puts activation into degraded mode with a user-facing error notification (see [DIST-FAILURE-UX]).

| Component ID | Binary | Required | Distribution |
|---|---|---|---|
| `sharplsp` | `sharplsp` / `sharplsp.exe` | **YES** | Bundled in per-platform VSIX: `bin/<platform>/sharplsp[.exe]` |
| `sharplsp-sidecar-csharp` | `sharplsp-sidecar-csharp` | **YES** | Bundled in every VSIX: `bin/all/sharplsp-sidecar-csharp` |
| `sharplsp-sidecar-fsharp` | `sharplsp-sidecar-fsharp` | **YES** | Bundled in every VSIX: `bin/all/sharplsp-sidecar-fsharp` |

All three are verified by Shipwright on every VS Code activation via `activationVerifies` in `shipwright.json`.

## [DIST-RUNTIME-ACQUIRE]

The sidecars are framework-dependent .NET assemblies. They require .NET 10 at run time. SharpLsp acquires this runtime automatically via Microsoft's [`ms-dotnettools.vscode-dotnet-runtime`](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.vscode-dotnet-runtime) extension (the .NET Install Tool) — the same mechanism used by C# Dev Kit, the C# extension, .NET MAUI, Unity, CMake, and Bicep.

> **Reference — how other extensions do this.** The .NET Install Tool's own README states it "provides a unified way for other extensions like the C# and C# Dev Kit extensions to install local versions of the .NET Runtime." C# Dev Kit ([`ms-dotnettools.csdevkit`](https://marketplace.visualstudio.com/items?itemName=ms-dotnettools.csdevkit)) declares it via `extensionDependencies` in its `package.json` — verified by the C# Dev Kit Marketplace listing showing `.NET Install Tool` as a prominent extension dependency. Authoritative API documentation lives at <https://github.com/dotnet/vscode-dotnet-runtime/blob/main/Documentation/commands.md>. SharpLsp follows this exact pattern — there is no Anthropic / Nimblesite-specific mechanism here, and any future maintainer asking "how do other VS Code extensions install .NET silently?" should land on this section and the linked docs.

**Hard rules:**

1. SharpLsp's [editors/vscode/package.json](../../editors/vscode/package.json) MUST declare `"extensionDependencies": ["ms-dotnettools.vscode-dotnet-runtime"]`. VS Code installs declared dependencies silently when SharpLsp is installed — no user prompt.
2. On every activation SharpLsp MUST call the `dotnet.acquire` command exposed by the .NET Install Tool with the parameter shape mandated in [DIST-API-PARAMETERS]. The command returns `{ dotnetPath: string }` pointing at a managed `dotnet` executable in per-user `globalStorage`. No admin/UAC/sudo. The runtime auto-updates patches every 24 h.
3. Before `dotnet.acquire`, SharpLsp MAY call `dotnet.findPath` with `versionSpecRequirement: 'greater_than_or_equal'` to skip acquisition when the user already has a compatible runtime. The path returned by either call is the runtime SharpLsp uses.
4. SharpLsp MUST set `DOTNET_ROOT` (the directory of `dotnetPath`) on the environment passed to the Rust LSP host so all spawned sidecars find that runtime.

**UX during acquisition — inform, never ask:**

- A non-interactive progress notification MUST appear: `vscode.window.withProgress({ location: vscode.window.ProgressLocation.Notification, title: 'SharpLsp: Installing .NET 10 runtime', cancellable: false }, ...)`.
- The `SharpLspStatusBar` MUST indicate the acquisition is in flight.
- Neither shows buttons, modals, or any UI that requires user action. No prompt, no terminal, no UAC.

**Failure path:** Surface per [DIST-FAILURE-UX]. Activation enters a degraded state and registers a `SharpLsp: Retry .NET acquisition` command. Activation MUST NOT crash the extension host or block other extensions.

Shipwright continues to verify sidecar startup via `verifyStartup: true`. With `DOTNET_ROOT` set correctly, the apphost finds the managed runtime and the version probe succeeds.

## [DIST-API-PARAMETERS]

Every call SharpLsp makes to the .NET Install Tool MUST include all four required fields in the `IDotnetAcquireContext`:

```ts
{
  version: '10.0',                     // major.minor only — the docs require this exact format
  mode: 'runtime',                     // 'runtime' | 'sdk' | 'aspnetcore'
  architecture: dotnetArchitecture(),  // 'x64' | 'arm64' | 'x86' — derived from process.arch
  requestingExtensionId: 'nimblesite.sharplsp',
}
```

`architecture` is derived from Node's `process.arch` and mapped as: `x64` → `x64`, `arm64` → `arm64`, `ia32` → `x86`, default → `x64`. This mapping lives in `editors/vscode/src/dotnetRuntime.ts`.

**Reasoning — why architecture is non-optional.**
The first SharpLsp v0.1.0 release omitted `architecture` from the `dotnet.findPath` payload. The .NET Install Tool rejected the request with `"The find path request was missing required information: a mode, version, architecture, and requestingExtensionId."` — a runtime error that our code silently swallowed via `try/catch`, falling through to `dotnet.acquire` (which also lacked `architecture` but happened to succeed because the install path uses different defaulting). This produced misleading log messages and would have failed entirely on architectures without a default. The lesson: every required field in the upstream API contract is a hard precondition, even when an "optional" code path papers over the omission.

This applies symmetrically to `dotnet.findPath` — its `acquireContext` MUST include `architecture` for the same reason.

**Verification:** Confirmed against the upstream contract at <https://github.com/dotnet/vscode-dotnet-runtime/blob/main/Documentation/commands.md> and against the live extension's own error message captured in the SharpLsp activation log on 2026-04-30.

## [DIST-FAILURE-UX]

Whenever activation cannot deliver a working language server — for any reason, at any step — SharpLsp MUST inform the user with a non-modal notification.  The extension MUST NEVER fail silently and MUST NEVER throw out of `activate()`.

**Hard rules:**

1. **`activate()` MUST always resolve, never reject.** Any error caught at the top level results in a non-modal error notification + degraded return value, never a re-throw. VS Code logs uncaught activation rejections to its own developer console where users do not see them — that is exactly the failure mode this rule prevents.
2. **Every non-trivial helper invoked from activation MUST return `Result<T, E>`** (from `editors/vscode/src/result.ts`). Helpers MUST NOT use `throw` for expected error paths. The only `throw` in the codebase is the one VS Code itself produces when an extension dependency is missing — and even that is caught and surfaced.
3. **Every failure surfaces a non-modal `vscode.window.showErrorMessage(…)`** with at minimum a `[Show Log]` button that calls `log.output().show()`. Where applicable, additional informational links MAY be added (`[Open dot.net]`, `[Retry]`, `[Reinstall]`). Buttons are convenience links, never required actions.
4. **The status bar MUST move to `ServerState.Error`** so the persistent indicator reflects the degraded state.
5. **The error message MUST name the failure mode in plain language** ("required binaries are missing or version-mismatched", ".NET 10 install failed", "language server crashed during startup") — never just dump a stack trace into the toast. The full diagnostic text goes to the output channel reachable via `[Show Log]`.
6. **Recovery commands MUST be registered** so the user can re-attempt without uninstalling. Examples: `sharplsp.retryDotnetAcquisition`, `sharplsp.restartServer`. These appear in the command palette under the `SharpLsp:` category.

**Reasoning — why this rule exists.**
The first v0.1.0 release threw out of `activate()` when bundled binaries were missing or had a version mismatch. VS Code logged the failure to its developer console — invisible to the user. The user opened a `.csproj` folder, saw absolutely nothing happen, and had no way to discover the problem without manually inspecting the extension log file. This is the worst possible UX: the extension is broken, the user does not know it is broken, and there is no in-product hint that anything went wrong. This section makes that mode of failure a normative bug going forward. Captured from the activation log on 2026-04-30: every error path now MUST produce a visible toast and an actionable command.

**Implementation reference:**
- `editors/vscode/src/result.ts` — `Result<T, E>`, `ok`, `err`.
- `editors/vscode/src/extension.ts` — outer `activate()` catch surfaces the toast; inner `activateInner()` step paths return early with toast + degraded API instead of throwing.
- `editors/vscode/src/dotnetRuntime.ts` — `acquireDotnet10` returns `Result<string, string>`; the caller pattern-matches.

## [DIST-VSIX-MODEL]

The VSIX is self-contained. A user who installs the extension gets everything they need with zero additional installation steps beyond the .NET 10 runtime (which is acquired automatically per [DIST-RUNTIME-ACQUIRE]).

- `sharplsp` — native Rust binary, pre-built per platform, bundled at `bin/<platform>/`
- `sharplsp-sidecar-csharp` — framework-dependent .NET assembly, bundled at `bin/all/`
- `sharplsp-sidecar-fsharp` — framework-dependent .NET assembly, bundled at `bin/all/`

**No component is ever installed via `dotnet tool install`, package manager, or any mechanism outside the VSIX.** The `dotnet-tool` source type is NOT used for VSIX distribution.

## [DIST-VSIX-LAYOUT]

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

## [DIST-RESOLUTION]

Resolution is driven by the `sources` array per component in `shipwright.json`. The `activateDeploymentToolkit` call verifies all three on activation. Failure to resolve any required component triggers [DIST-FAILURE-UX] (degraded mode + toast), not a host-crashing throw.

## [DIST-RESOLUTION-LSP]

`sharplsp` (LSP server — native binary).

Sources: `["user-setting", "env", "bundled", "path", "pkgmgr"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.lspPath` VS Code setting — absolute path; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_LSP_PATH` (full path) or `SHARPLSP_BINARY_DIR` (directory); version drift = `ok-with-warning` |
| 3 | **`bundled`** | `bin/<platform>/sharplsp[.exe]` inside `extensionPath` ← **DEFAULT for all users** |
| 4 | `path` | `sharplsp` on `$PATH`; exact version match required |
| 5 | `pkgmgr` | Shows modal prompt: `brew install nimblesite/tap/sharplsp` / `scoop install nimblesite/sharplsp` |

## [DIST-RESOLUTION-CSHARP]

`sharplsp-sidecar-csharp` (C# Roslyn sidecar — .NET assembly).

Sources: `["user-setting", "env", "bundled", "path"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.csharpSidecarPath` VS Code setting; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_CSHARP_SIDECAR_PATH` (full path) |
| 3 | **`bundled`** | `bin/all/sharplsp-sidecar-csharp` inside `extensionPath` ← **DEFAULT for all users** |
| 4 | `path` | `sharplsp-sidecar-csharp` on `$PATH`; exact version match required |

**If bundled binary is missing the VSIX is broken — fix the build, not the resolution.** Surface per [DIST-FAILURE-UX].

## [DIST-RESOLUTION-FSHARP]

`sharplsp-sidecar-fsharp` (F# FCS sidecar — .NET assembly).

Sources: `["user-setting", "env", "bundled", "path"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.fsharpSidecarPath` VS Code setting; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_FSHARP_SIDECAR_PATH` (full path) |
| 3 | **`bundled`** | `bin/all/sharplsp-sidecar-fsharp` inside `extensionPath` ← **DEFAULT for all users** |
| 4 | `path` | `sharplsp-sidecar-fsharp` on `$PATH`; exact version match required |

**F# is first-class. No SharpLsp without F# support. If bundled binary is missing the VSIX is broken — fix the build.** Surface per [DIST-FAILURE-UX].

## [DIST-VERSION-MATCH]

| Source | Version mismatch behaviour |
|---|---|
| `user-setting` | Hard error — surfaced via [DIST-FAILURE-UX], degraded mode |
| `env` | `ok-with-warning` — activation continues |
| `bundled` | `ok-with-warning` — activation continues |
| `path` | Skipped (no match) — falls through to next source |

## [DIST-VERSION-INVARIANT]

`Cargo.toml` `version` is the single source of truth. The release workflow stamps the tag version into `Cargo.toml` and `editors/vscode/package.json`, commits and pushes those changes, then builds all artifacts from that commit. Sidecar versions are set via `-p:PackageVersion` at publish time.

All versions MUST match byte-for-byte for a release to be valid.

## [DIST-VERSION-OUTPUT]

| Binary | Expected stdout |
|---|---|
| `sharplsp --version` | `sharplsp <semver>` |
| `sharplsp-sidecar-csharp --version` | `sharplsp-sidecar-csharp <semver>` |
| `sharplsp-sidecar-fsharp --version` | `sharplsp-sidecar-fsharp <semver>` |

The first whitespace-delimited token MUST exactly match the component `id` in `shipwright.json`.

## [DIST-EDITOR-CONTRACT]

The VS Code extension uses `@nimblesite/shipwright-vscode` (`activateDeploymentToolkit`) to resolve all three components. The extension MUST:

1. **Never hand-roll binary resolution** — use `activateDeploymentToolkit` exclusively.
2. **Never download binaries over HTTPS** — all binaries ship in the VSIX, except .NET 10 itself which is acquired via the .NET Install Tool extension (see [DIST-RUNTIME-ACQUIRE]).
3. **Never treat any sidecar as optional** — both sidecars are required, both crash activation if missing.
4. **Surface every failure per [DIST-FAILURE-UX]** if any component returns `status: "error"`. The .NET 10 runtime is NOT a bundled component; failure to acquire it enters degraded mode per [DIST-RUNTIME-ACQUIRE].
5. **Pass the Shipwright-resolved path** to `LanguageClient` — never hardcode a binary path.
6. **Acquire .NET 10 at activation start** via `dotnet.acquire` from the .NET Install Tool extension (see [DIST-RUNTIME-ACQUIRE]). Show a non-interactive progress notification + status-bar spinner. Never prompt, never block on user action.
7. **Use `Result<T, E>` everywhere** per [DIST-FAILURE-UX]. No `throw` inside extension code; no unhandled rejections out of `activate()`.

## [DIST-PATH-INSTALL]

Users who want `sharplsp` on their system PATH outside VS Code may install via:

- **macOS/Linux**: `brew install nimblesite/tap/sharplsp`
- **Windows**: `scoop install nimblesite/sharplsp`

This is entirely optional. The bundled VSIX binary is sufficient for VS Code users.

## [DIST-RELEASE]

Tag-triggered (`v*`). Jobs:

1. **`build-sharplsp`** — matrix: 6 targets (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64, win32-arm64). Produces one native binary per platform.
2. **`publish-sidecars`** — single ubuntu job. `dotnet publish --no-self-contained` both sidecars. Produces the `bin/all/` assemblies staged for VSIX inclusion.
3. **`build-vsix`** — for each platform: stages `bin/<platform>/sharplsp[.exe]` + `bin/all/sharplsp-sidecar-*`, runs `vsce package --target <platform>`. Produces 6 per-platform `.vsix` files, each fully self-contained.
4. **`release`** — creates GitHub release with all archives and VSIXs, updates Homebrew tap, updates Scoop bucket, publishes VSIXs to VS Code Marketplace.

## [DIST-CI-NODE]

**Minimum: Node.js 20.x.x.** This is the minimum required by `@vscode/vsce` v3.x.

Ground truth: <https://github.com/microsoft/vscode-vsce>

All CI jobs that run `vsce package` or `vsce publish` MUST use `node-version: '20'` or higher. Do not upgrade beyond what vsce requires without checking the above URL first.

## [DIST-CI-DOTNET]

**Required: .NET 10.** All sidecar publish steps use `dotnet publish --no-self-contained` targeting `net10.0`.

## [DIST-CI-RUST]

Stable toolchain. Cross-compilation targets must be added via `dtolnay/rust-toolchain@stable` with explicit `targets:`.

## [DIST-CI-WIN-TRANSPORT]

`tokio::net::UnixStream` is **unix-only** and MUST NOT be used unconditionally. All sidecar transport code MUST be gated:
- `#[cfg(unix)]` — use `tokio::net::UnixStream`
- `#[cfg(windows)]` — use TCP loopback (`127.0.0.1:0`) or `tokio::net::windows::named_pipe`

Both the Rust host and the .NET sidecar MUST use the same transport on each platform. Win32 builds failing to compile due to `UnixStream` is a hard blocker.

## [DIST-SECRETS]

The VS Code Marketplace publishes **passwordless via Microsoft Entra ID OIDC** (workload identity federation) — there is **no** long-lived Marketplace PAT. The `release.yml` `publish-marketplace` job runs in the `release` GitHub Environment so its OIDC subject is the deterministic `repo:Nimblesite/SharpLsp:environment:release`, which one Entra federated credential trusts. Open VSX has **no** OIDC/trusted-publishing path (verified 2026), so it still requires a long-lived access token.

| Secret / Variable | Scope | Purpose |
|---|---|---|
| `BREW_SCOOP_PAT` | repo | PAT with `contents:write` on `Nimblesite/homebrew-tap` and `Nimblesite/scoop-bucket` |
| `AZURE_CLIENT_ID` | `release` env | Entra ID app (client) id — Marketplace OIDC publish. Not sensitive; no PAT involved. |
| `AZURE_TENANT_ID` | `release` env | Entra ID tenant (directory) id — Marketplace OIDC publish. |
| `OPEN_VSX_PAT` | repo | Open VSX access token. No OIDC path exists; long-lived token required (rotate on a schedule — post-2025 tokens expire by default). |

## [DIST-CI-SMOKE]

Every PR:
- Validates `shipwright.json` with `shipwright-validate-manifest`
- Runs `dotnet publish --no-self-contained` on both sidecars
- Verifies `bin/<platform>/sharplsp[.exe]` exists in the staged VSIX layout
- Verifies `bin/all/sharplsp-sidecar-csharp` exists in the staged VSIX layout
- Verifies `bin/all/sharplsp-sidecar-fsharp` exists in the staged VSIX layout
- Runs `sharplsp --version`, `sharplsp-sidecar-csharp --version`, `sharplsp-sidecar-fsharp --version`

## [DIST-FORBIDDEN]

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
