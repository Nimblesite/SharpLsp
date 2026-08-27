# Distribution Implementation Plan

Implementation plan for [DISTRIBUTION-SPEC.md](../specs/DISTRIBUTION-SPEC.md).

## Context — why this plan was reopened (2026-04-30)

The v0.1.0 GitHub release shipped framework-dependent sidecars (`dotnet publish --no-self-contained`, target `net10.0`) without any mechanism to acquire .NET 10 on the user's machine. On any host that doesn't already have .NET 10 installed, the apphost exits with code 150 ("You must install or update .NET") and Shipwright's startup probe reports `version check failed... no resolved source` — a useless diagnostic. The previous spec demanded the extension "MUST crash with a clear error" if .NET 10 was missing, which is the wrong UX.

This rev replaces that stance with delegation to Microsoft's `ms-dotnettools.vscode-dotnet-runtime` extension (the .NET Install Tool) — the same mechanism C# Dev Kit, the C# extension, .NET MAUI, Unity, CMake, and Bicep use. SharpLsp acquires .NET 10 silently on activation while showing a non-interactive progress notification + status-bar spinner. The user is informed but never asked to do anything. See [DIST-RUNTIME-ACQUIRE](../specs/DISTRIBUTION-SPEC.md) and [DIST-FORBIDDEN](../specs/DISTRIBUTION-SPEC.md).

## TODO Checklist — .NET Install Tool integration (priority)

### VS Code extension wiring

- [x] Add `"extensionDependencies": ["ms-dotnettools.vscode-dotnet-runtime"]` to [src/editors/vscode/package.json](../../src/editors/vscode/package.json) (insert after the `engines` block, around line 11)
- [x] Create new file `src/editors/vscode/src/dotnetRuntime.ts` exporting `acquireDotnet10(log, statusBar): Promise<string>` returning the path to `dotnet` / `dotnet.exe`
- [x] In `dotnetRuntime.ts`, first call `dotnet.findPath` with `{ acquireContext: { version: '10.0', mode: 'runtime', requestingExtensionId: 'nimblesite.sharplsp' }, versionSpecRequirement: 'greater_than_or_equal' }` — if it returns a path, skip acquisition
- [x] Otherwise call `dotnet.acquire` with `{ version: '10.0', mode: 'runtime', requestingExtensionId: 'nimblesite.sharplsp' }`
- [x] Wrap the call in `vscode.window.withProgress({ location: vscode.window.ProgressLocation.Notification, title: 'SharpLsp: Installing .NET 10 runtime', cancellable: false }, ...)` — non-interactive toast spinner
- [x] Update `SharpLspStatusBar` to show "Installing .NET 10…" via `statusBar.setState(ServerState.Starting)` plus a custom message during acquisition
- [x] Define a typed `DotnetAcquireError` thrown on acquisition failure
- [x] In [src/editors/vscode/src/extension.ts](../../src/editors/vscode/src/extension.ts), insert `step 10c: acquireDotnet10` between line 133 (`initProjectDepsStore`) and line 135 (`activateDeploymentToolkit`); store `dotnetPath` for downstream use
- [x] On `DotnetAcquireError`, render a non-modal error notification with `[Open dot.net]` (uses `vscode.env.openExternal`) and `[Show log]` buttons — both informational, no required action; enter degraded state without throwing
- [x] Register a `sharplsp.retryDotnetAcquisition` command for the degraded-state recovery path (re-runs `acquireDotnet10` and resumes activation if it succeeds)
- [x] In [src/editors/vscode/src/client.ts](../../src/editors/vscode/src/client.ts), extend `sidecarEnv` (lines 78–87) to accept `dotnetPath` and set `DOTNET_ROOT` to its directory on the env passed to the Rust LSP host
- [x] Update `client.start(...)` signature in extension.ts to thread `dotnetPath` through

### Rust host (sidecar spawn)

- [x] Locate the Rust sidecar spawn site — `src/sharplsp/src/sidecar/manager.rs` lines 168–179 (`tokio::process::Command::new(&self.spawn_command)`)
- [x] Verify `Command::spawn` inherits the parent process env — confirmed: no `env_clear` / `env_remove` / explicit `.env(…)` calls anywhere in `src/sharplsp/src/sidecar/`, so `DOTNET_ROOT` flows VS Code → sharplsp → sidecar via tokio's default env inheritance
- [~] Unit test for `DOTNET_ROOT` propagation — skipped per CLAUDE.md ("No unit tests. Only COARSE e2e tests."). The end-to-end activation checklist below validates the full path.

### Specs & docs

- [x] Rewrite [DIST-RUNTIME-ACQUIRE](../specs/DISTRIBUTION-SPEC.md) from a runtime prerequisite into .NET 10 SDK acquisition via the .NET Install Tool
- [x] Add the C# Dev Kit `extensionDependencies` pattern to [DIST-RUNTIME-ACQUIRE](../specs/DISTRIBUTION-SPEC.md)
- [x] Update [DIST-EDITOR-CONTRACT](../specs/DISTRIBUTION-SPEC.md) for degraded mode and SDK acquisition
- [x] Update [DIST-FORBIDDEN](../specs/DISTRIBUTION-SPEC.md): prohibit required-action UI and hand-rolled .NET acquisition
- [x] Update DISTRIBUTION-PLAN.md (this file) with the new TODO block and Context section
- [x] Add a callout from [SHARPLSP-DISTRIBUTION](../specs/SHARPLSP-SPEC.md) to [DIST-RUNTIME-ACQUIRE](../specs/DISTRIBUTION-SPEC.md)

### Verification (clean Windows machine, no .NET 10 installed)

- [ ] `make package-vsix-win32-x64 VERSION=0.1.1` succeeds
- [ ] Uninstall SharpLsp: `code --uninstall-extension nimblesite.sharplsp`
- [ ] Uninstall the .NET Install Tool: `code --uninstall-extension ms-dotnettools.vscode-dotnet-runtime`
- [ ] `code --install-extension dist/sharplsp-win32-x64.vsix` — VS Code auto-installs the .NET Install Tool dependency without prompting
- [ ] `code --list-extensions | grep ms-dotnettools.vscode-dotnet-runtime` prints the ID
- [ ] Open a `.csproj`-containing folder. Observe the `SharpLsp: Installing .NET 10 runtime` toast appear with spinner, plus the status-bar message. No buttons. 30-90 s later toast disappears.
- [ ] LSP completion works on a `.cs` file
- [ ] Reload window — toast does NOT reappear (cached); activation is instant
- [ ] SharpLsp output channel logs `step 10c: acquireDotnet10` and `acquired dotnet at <path>`
- [ ] Delete cache (`rmdir /s /q "%APPDATA%\Code\User\globalStorage\ms-dotnettools.vscode-dotnet-runtime"`), reload — toast reappears, re-downloads, re-activates
- [ ] Disconnect network, delete cache, reload — non-modal error notification appears with `[Open dot.net]` link; `[Show log]` opens the log file; `sharplsp.retryDotnetAcquisition` command shows in palette
- [ ] Reconnect network, run `sharplsp.retryDotnetAcquisition` — acquisition completes, LSP starts
- [ ] Repeat all of the above on macOS (darwin-arm64) and Linux (linux-x64)
- [ ] Confirm Shipwright no longer reports `Deployment toolkit (sharplsp-sidecar-csharp): version check failed... no resolved source`

### Failure UX — silent activation failure must be impossible

Triggered by the v0.1.0 production log captured 2026-04-30: missing bundled binaries caused `activate()` to throw, which VS Code logs to its developer console where users do not see it. Spec section: `[DIST-FAILURE-UX]`.

- [x] Introduce `src/editors/vscode/src/result.ts` with `Result<T, E>`, `ok()`, `err()` per CLAUDE.md "all fallible functions return Result<T, E>"
- [x] Rewrite `src/editors/vscode/src/dotnetRuntime.ts` so `acquireDotnet10` returns `Result<string>` (no throws); `safeExecuteCommand` adapts upstream rejections into `Err`
- [x] Add the missing `architecture` field to both `dotnet.acquire` and `dotnet.findPath` payloads (per `[DIST-API-PARAMETERS]`); export `dotnetArchitecture()` for tests
- [x] In `src/editors/vscode/src/extension.ts`, make `activate()` always resolve — outer catch surfaces a non-modal toast and returns a degraded API
- [x] Replace the `throw new Error(msg)` on the deployment-toolkit failure path with a non-modal toast + degraded return
- [x] Replace the deferred `window.showErrorMessage` on the `client.start` failure with `notifyActivationFailure(headline, detail)` (consistent UX)
- [x] Add `notifyActivationFailure(headline, detail)` exported helper with `[Show Log]` and `[Restart Window]` buttons
- [x] Add `degradedApi()` helper so every error path returns a usable API surface
- [x] Convert the retry command to consume `Result` from `acquireDotnet10`
- [x] Tag every Result-based path with `Implements [DIST-FAILURE-UX]` / `Implements [DIST-API-PARAMETERS]` per CLAUDE.md spec-ID rule
- [x] Add `src/editors/vscode/src/test/suite/unit-result.test.ts` — pins the Result type contract *(deleted in the #125 e2e conversion; coverage lives in the e2e suites)*
- [x] Add `src/editors/vscode/src/test/suite/unit-dotnet-runtime.test.ts` — patches `vscode.commands.executeCommand`, asserts the four required fields are sent, asserts no path throws *(deleted in the #125 e2e conversion; `lifecycle-e2e.test.ts` covers the acquisition flow end-to-end)*
- [x] Add `src/editors/vscode/src/test/suite/unit-failure-ux.test.ts` — asserts `activate()` resolves (never rejects), the retry command is registered, `extensionDependencies` declares the .NET Install Tool, `notifyActivationFailure` is exported *(deleted in the #125 e2e conversion; most coverage moved to `lifecycle-e2e.test.ts`/`extension.test.ts` — the `extensionDependencies` guards were dropped and restored below)*

### Salvaged from the `fixrelease` branch (2026-07-16 audit)

A full audit of the retired `fixrelease` branch (39 commits, 90 files) found everything absorbed by main except two items, restored here:

- [x] Restore the `[DIST-RUNTIME-ACQUIRE]` manifest guards dropped by the #125 e2e conversion — `extension.test.ts` now asserts `extensionDependencies` declares the .NET Install Tool and that it resolves in the test host (the test host installs it unconditionally via `.vscode-test.mjs`, so nothing else fails when the declaration is removed)
- [x] Salvage `tools/vsix/resolve-symlink-stubs.mjs` (from the branch's auto-stash) — resolves Git text-symlink stubs for the icon assets on `core.symlinks=false` checkouts; wired into `pretest`/`vscode:prepublish` per [DIST-VSIX-ASSET-INTEGRITY], invariant asserted e2e in `bundled-binary.test.ts`

### Spec hygiene — sweep numbered headings (CLAUDE.md violation)

CLAUDE.md mandates hierarchical IDs (`[GROUP-TOPIC]`), uppercase, hyphen-separated, never numbered. `docs/specs/DISTRIBUTION-SPEC.md` has been converted. The remaining 11 specs still use numbered headings and need a careful pass:

- [x] `docs/specs/DISTRIBUTION-SPEC.md` — converted in this rev
- [ ] `docs/specs/SHARPLSP-SPEC.md` — 44 numbered headings (cross-link to `DIST-RUNTIME-ACQUIRE` already updated)
- [ ] `docs/specs/BINARY-DEPLOYMENT.md` — 6
- [ ] `docs/specs/DEBUGGING-SPEC.md` — 51
- [ ] `docs/specs/DEFINITION-SPEC.md` — 29
- [ ] `docs/specs/DIAGNOSTICS-SPEC.md` — 34
- [ ] `docs/specs/HOVER-SPEC.md` — 18
- [ ] `docs/specs/NUGET-BROWSER-SPEC.md` — 27
- [ ] `docs/specs/PROFILER-SPEC.md` — 34
- [ ] `docs/specs/REFERENCES-SPEC.md` — 22
- [ ] `docs/specs/RIDER-PLUGIN-SPEC.md` — 21
- [ ] `docs/specs/VSCODE-REACTIVITY-SPEC.md` — 10

### Release

- [ ] Stamp v0.1.1 and re-release once verification passes on all three platforms

## TODO Checklist — original v0.1.0 work (status snapshot)

### Sidecar dotnet tool packaging

- [x] Add `PackAsTool`, `ToolCommandName`, `PackageId` to C# sidecar `.csproj`
- [x] Add `Authors`, `Description`, `PackageLicenseExpression`, `RepositoryUrl` to C# sidecar
- [x] Add `RollForward` and `CopyLocalLockFileAssemblies` to C# sidecar
- [x] Verify F# sidecar `.fsproj` has all required tool properties
- [x] Add `--version` flag handling to C# sidecar `Program.cs`
- [x] Add `--version` flag handling to F# sidecar `Program.fs`
- [x] Remove `SelfContained` from any sidecar project (confirmed not present in any sidecar .csproj/.fsproj)
- [x] Local dry-run: `dotnet pack` + `dotnet tool install -g` + `--version` check — `make install-binaries` executes this; CI lint job runs `dotnet pack` smoke test

### Rust binary

- [x] `sharplsp --version` prints `sharplsp <semver>`
- [x] E2E test validates version output format

### Release workflow (`.github/workflows/release.yml`)

- [x] Job: `build-sharplsp` — matrix build, single binary archives (no sidecars)
- [x] Job: `pack-sidecars` — framework-dependent `dotnet pack`, 2 nupkgs
- [x] Job: `release` — GitHub release, NuGet publish, Homebrew tap, Scoop bucket
- [ ] Test with a `v*-rc*` tag on a fork

### CI smoke test

- [x] Add `dotnet pack` step to `ci.yml` lint job

### CI wall-clock ([DIST-CI-RUST-SHARDS])

- [x] Split `test-rust` into 2 nextest hash-partition shards (`make _test-rust-shard`)
- [x] Union-merge shard lcov + single ratchet gate (`coverage-rust` job, `tools/coverage/merge-lcov.mjs`)
- [x] Move the `--version` contract checks to a dedicated `version-contract` job
- [x] Run test jobs concurrently with `lint` (removed `needs: lint`)
- [ ] Confirm shard wall times on a real PR run; rebalance `SHARD_COUNT` if a shard drifts past ~6 min

### Windows VS Code feature chunks ([DIST-CI-WIN-VSIX])

- [x] Replace the `MOCHA_GREP` smoke subset with file-glob chunk selection (`MOCHA_FILES` in `src/test/suite/index.ts`); a glob matching nothing is a hard error
- [x] Declare chunk membership once in `src/editors/vscode/test-chunks.json`, read by `tools/vsix/vsix-test-chunks.mjs` (`files` / `matrix` / `check`)
- [x] Cover the whole feature surface on Windows: `lifecycle`, `lsp`, `fsharp`, `debug` (netcoredbg + Test Explorer + CodeLens), `profiler` (trace/counters/dumps + FSI/build/hot-reload), `explorer` (tree + context menus), `packages` (scaffolding + NuGet)
- [x] Guard completeness in lint (`_check-vsix-chunks`) so a new suite cannot silently skip Windows CI
- [x] Build once / fan out: one Windows `build` job publishes host + sidecars; chunks stage via `_stage-vsix-binary-only`
- [x] `fail-fast: false` on the chunk matrix so one feature area's failure never hides the others
- [ ] Confirm per-chunk wall times on a real PR run; split `explorer` / `packages` if either drifts past ~30 min

#### Windows-only defects the widened gate surfaced immediately

Every one of these shipped green on Ubuntu and had never executed on Windows at all, because the previous `MOCHA_GREP` smoke subset did not select them:

- [x] `bundled-sidecars.test.ts` asserted extensionless `bin/all/sharplsp-sidecar-*`, but Windows stages `…​.exe` (shipwright's bundlePath is `bin/all/…${exe}`). Now uses `exeName()`, matching the contract `00-vsix-dev-binary-staging.test.ts` already documented.
- [x] `bundled-binary.test.ts` compared `extensionPath`-derived paths against shipwright's `Uri.fsPath`-derived path with `strictEqual`. VS Code lowercases the drive letter in `fsPath`, so the same file has two spellings on win32; comparison is now case-insensitive on Windows only (POSIX stays case-sensitive). Shared as `comparablePath()` in `test-helpers.ts`.
- [x] `debug-e2e.test.ts` compared three resolved `program` paths the same way — the auto-detected `.dll` from a real `.csproj`, the `provideDebugConfigurations` default, and the `sharplsp.debugProgram` entry point. All three now use `comparablePath()`.
- [x] `scaffolding-e2e.test.ts` compared `generateFileContent`'s `\n` output against the editor buffer and the saved file. VS Code gives a new document the platform EOL and rewrites inserted text to match, so on Windows both legitimately hold `\r\n`. Now normalized via `comparableText()`; the content assertions are unchanged.
- [x] `testing-lens-e2e.test.ts` asserted the "no discovered test matches" warning path using a fixture method named `Adds_TwoNumbers` — the same name `test-explorer-e2e.test.ts` discovers into the shared `SharpLspTestController`. The suite therefore passed or failed on whether that discovery won the race (green on Ubuntu, red on Windows). Fixture methods are now suite-unique (`Lens_Adds*`), so the precondition holds regardless of execution order.
  - **Open product bug this de-pressurized:** `runTestByMethodName` ([src/test-lens.ts](../../src/editors/vscode/src/test-lens.ts)) discards the URI its command receives and matches ANY discovered test whose id's last dot-segment equals the bare method name, last-match-wins — so run/debug-at-cursor can execute a test from a different project, and `findResultByMethodName` mis-attributes the CodeLens badge the same way. The rename is still correct (suites must be order-independent), but the collision is now untested. Needs a URI/project-scoped lookup plus a regression test.

Two further failure classes were investigated and turned out **not** to be defects, so no code changed:

- C# completion (`completions-visible`, `lsp-integration`) reporting kind `Text(0)` instead of `Property(9)`, and all four F# completion suites exhausting their poll, were both traced to a **stale sidecar build in the working tree**, not to the suites and not to the product. Once the sidecars were rebuilt, `lsp` ran 63/0 and `fsharp` 35/0. Do not "fix" these by loosening the poll predicates: waiting for a Roslyn-backed `CompletionItemKind` converts a clear `0 !== 9` assertion failure into an opaque 90-second mocha timeout, which is strictly worse to diagnose. Rebuild the sidecars first (`make _build-dotnet`) before believing a completion failure.

### CI workflow layout ([DIST-CI-LAYOUT])

- [x] Split `ci.yml` into reusable workflows: `ci-lint`, `ci-rust`, `ci-dotnet`, `ci-vsix`, `ci-vsix-windows`
- [x] De-duplicate the PATH-purge step into `tools/vsix/purge-path-binaries.sh` (was inline in three jobs)
- [x] De-duplicate the test-host env scrubbing into the `VSIX_TEST_ENV` Make variable
- [x] Fix the Rust test job's NuGet cache step (was `actions/setup-node` with `actions/cache` inputs, so it never cached)

### VS Code extension (`install.ts`)

- [x] Replace HTTPS download path with package-manager-driven install
- [x] Version check via `--version` spawn for all three binaries
- [x] Package manager presence checks (brew/scoop/dotnet)
- [x] Modal prompts for install/update
- [x] Remove `downloadToFile`, `extractTarGz`, `downloadAndInstall`
- [x] Remove bundled binary path, `~/.local` staging path

### Makefile

- [x] Add `install-rust` target (copies sharplsp to `$PREFIX/bin`)
- [x] Add `install-sidecars` target (dotnet tool install from local nupkgs)
- [x] Keep `install-binaries` as alias for both
- [x] Verify `test-vsix` still works with new install layout — `make test-vsix` stages binaries at `$(PREFIX)` and runs tests with coverage; all passing

### Documentation

- [x] Create `docs/specs/DISTRIBUTION-SPEC.md`
- [x] Create `docs/plans/DISTRIBUTION-PLAN.md`
- [x] Add Distribution section to `docs/specs/SHARPLSP-SPEC.md`

### External prerequisites (manual, pre-merge)

- [ ] Create GitHub repo `Nimblesite/homebrew-tap` (empty, default branch `main`)
- [ ] Create GitHub repo `Nimblesite/scoop-bucket` (empty, default branch `main`)
- [ ] Create PAT with `contents:write` on both repos → add as `BREW_SCOOP_PAT`
- [ ] Create NuGet.org API key → add as `NUGET_API_KEY`
- [ ] Reserve `SharpLsp.Sidecar.CSharp` and `SharpLsp.Sidecar.FSharp` on nuget.org

### Verification

- [ ] Local dry-run of sidecar packaging (pack → install → `--version`)
- [ ] VSIX verification: version mismatch triggers modal with correct command
- [ ] Tag-driven end-to-end on test fork
- [ ] Clean macOS VM: brew install + dotnet tool install → extension activates
- [ ] Clean Windows VM: scoop install + dotnet tool install → extension activates
