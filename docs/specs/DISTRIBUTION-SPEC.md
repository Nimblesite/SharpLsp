# Distribution Specification

This document is the canonical specification for how SharpLsp is distributed.
All statements below are normative requirements, not suggestions.

## 1. Components

SharpLsp has three executable components. All three are REQUIRED and MUST be bundled in the VSIX. Missing any one of them crashes activation — no graceful degradation, no optional behaviour.

| Component ID | Binary | Required | Distribution |
|---|---|---|---|
| `sharplsp` | `sharplsp` / `sharplsp.exe` | **YES** — crashes activation if missing | Bundled in per-platform VSIX: `bin/<platform>/sharplsp[.exe]` |
| `sharplsp-sidecar-csharp` | `sharplsp-sidecar-csharp` | **YES** — crashes activation if missing | Bundled in every VSIX: `bin/all/sharplsp-sidecar-csharp` |
| `sharplsp-sidecar-fsharp` | `sharplsp-sidecar-fsharp` | **YES** — crashes activation if missing | Bundled in every VSIX: `bin/all/sharplsp-sidecar-fsharp` |

All three are verified by Shipwright on every VS Code activation via `activationVerifies` in `shipwright.json`.

## 2. Runtime Prerequisite — .NET 10

The sidecars are framework-dependent .NET assemblies. They require .NET 10 to be installed on the host machine. This is a hard prerequisite — SharpLsp is a .NET language server, and there is no point running it without the .NET runtime.

**If .NET 10 is not installed, activation MUST crash with a clear error.** There is no fallback, no prompt, no graceful degradation. The error message MUST instruct the user to install .NET 10 from https://dot.net.

Shipwright verifies sidecar startup via `verifyStartup: true`. If `dotnet bin/all/sharplsp-sidecar-csharp.dll --version` fails, it means .NET is missing or broken — activation crashes.

## 3. Primary Distribution Model — Self-Contained VSIX

The VSIX is self-contained. A user who installs the extension gets everything they need with zero additional installation steps beyond the .NET 10 runtime.

- `sharplsp` — native Rust binary, pre-built per platform, bundled at `bin/<platform>/`
- `sharplsp-sidecar-csharp` — framework-dependent .NET assembly, bundled at `bin/all/`
- `sharplsp-sidecar-fsharp` — framework-dependent .NET assembly, bundled at `bin/all/`

**No component is ever installed via `dotnet tool install`, package manager, or any mechanism outside the VSIX.** The `dotnet-tool` source type is NOT used for VSIX distribution.

### Per-Platform VSIX Layout

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

## 4. Shipwright Resolution — All Three Components

Resolution is driven by the `sources` array per component in `shipwright.json`. The `activateDeploymentToolkit` call verifies all three on activation. All three crash activation if unresolved.

### `sharplsp` (LSP server — native binary)

Sources: `["user-setting", "env", "bundled", "path", "pkgmgr"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.lspPath` VS Code setting — absolute path; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_LSP_PATH` (full path) or `SHARPLSP_BINARY_DIR` (directory); version drift = `ok-with-warning` |
| 3 | **`bundled`** | `bin/<platform>/sharplsp[.exe]` inside `extensionPath` ← **DEFAULT for all users** |
| 4 | `path` | `sharplsp` on `$PATH`; exact version match required |
| 5 | `pkgmgr` | Shows modal prompt: `brew install nimblesite/tap/sharplsp` / `scoop install nimblesite/sharplsp` |

### `sharplsp-sidecar-csharp` (C# Roslyn sidecar — .NET assembly)

Sources: `["user-setting", "env", "bundled", "path"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.csharpSidecarPath` VS Code setting; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_CSHARP_SIDECAR_PATH` (full path) |
| 3 | **`bundled`** | `bin/all/sharplsp-sidecar-csharp` inside `extensionPath` ← **DEFAULT for all users** |
| 4 | `path` | `sharplsp-sidecar-csharp` on `$PATH`; exact version match required |

**If bundled binary is missing the VSIX is broken — fix the build, not the resolution.**

### `sharplsp-sidecar-fsharp` (F# FCS sidecar — .NET assembly)

Sources: `["user-setting", "env", "bundled", "path"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.fsharpSidecarPath` VS Code setting; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_FSHARP_SIDECAR_PATH` (full path) |
| 3 | **`bundled`** | `bin/all/sharplsp-sidecar-fsharp` inside `extensionPath` ← **DEFAULT for all users** |
| 4 | `path` | `sharplsp-sidecar-fsharp` on `$PATH`; exact version match required |

**F# is first-class. No SharpLsp without F# support. If bundled binary is missing the VSIX is broken — fix the build.**

## 5. Version Matching Semantics

| Source | Version mismatch behaviour |
|---|---|
| `user-setting` | Hard error — activation crashes |
| `env` | `ok-with-warning` — activation continues |
| `bundled` | `ok-with-warning` — activation continues |
| `path` | Skipped (no match) — falls through to next source |

## 6. Version Invariant

`Cargo.toml` `version` is the single source of truth. The release workflow stamps the tag version into `Cargo.toml` and `editors/vscode/package.json`, commits and pushes those changes, then builds all artifacts from that commit. Sidecar versions are set via `-p:PackageVersion` at publish time.

All versions MUST match byte-for-byte for a release to be valid.

### `--version` output format

| Binary | Expected stdout |
|---|---|
| `sharplsp --version` | `sharplsp <semver>` |
| `sharplsp-sidecar-csharp --version` | `sharplsp-sidecar-csharp <semver>` |
| `sharplsp-sidecar-fsharp --version` | `sharplsp-sidecar-fsharp <semver>` |

The first whitespace-delimited token MUST exactly match the component `id` in `shipwright.json`.

## 7. Editor Extension Contract

The VS Code extension uses `@nimblesite/shipwright-vscode` (`activateDeploymentToolkit`) to resolve all three components. The extension MUST:

1. **Never hand-roll binary resolution** — use `activateDeploymentToolkit` exclusively.
2. **Never download binaries over HTTPS** — all binaries ship in the VSIX.
3. **Never treat any sidecar as optional** — both sidecars are required, both crash activation if missing.
4. **Crash activation** if any component returns `status: "error"` — no graceful degradation.
5. **Pass the Shipwright-resolved path** to `LanguageClient` — never hardcode a binary path.
6. **Crash activation with a clear error** if .NET 10 is not detected on the host.

## 8. Optional PATH Install

Users who want `sharplsp` on their system PATH outside VS Code may install via:

- **macOS/Linux**: `brew install nimblesite/tap/sharplsp`
- **Windows**: `scoop install nimblesite/sharplsp`

This is entirely optional. The bundled VSIX binary is sufficient for VS Code users.

## 9. Release Workflow

Tag-triggered (`v*`). Jobs:

1. **`build-sharplsp`** — matrix: 6 targets (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64, win32-arm64). Produces one native binary per platform.
2. **`publish-sidecars`** — single ubuntu job. `dotnet publish --no-self-contained` both sidecars. Produces the `bin/all/` assemblies staged for VSIX inclusion.
3. **`build-vsix`** — for each platform: stages `bin/<platform>/sharplsp[.exe]` + `bin/all/sharplsp-sidecar-*`, runs `vsce package --target <platform>`. Produces 6 per-platform `.vsix` files, each fully self-contained.
4. **`release`** — creates GitHub release with all archives and VSIXs, updates Homebrew tap, updates Scoop bucket, publishes VSIXs to VS Code Marketplace.

## 10. CI Toolchain Requirements

### Node.js

**Minimum: Node.js 20.x.x.** This is the minimum required by `@vscode/vsce` v3.x.

Ground truth: https://github.com/microsoft/vscode-vsce

All CI jobs that run `vsce package` or `vsce publish` MUST use `node-version: '20'` or higher. Do not upgrade beyond what vsce requires without checking the above URL first.

### .NET

**Required: .NET 10.** All sidecar publish steps use `dotnet publish --no-self-contained` targeting `net10.0`.

### Rust

Stable toolchain. Cross-compilation targets must be added via `dtolnay/rust-toolchain@stable` with explicit `targets:`.

### Windows sidecar transport

`tokio::net::UnixStream` is **unix-only** and MUST NOT be used unconditionally. All sidecar transport code MUST be gated:
- `#[cfg(unix)]` — use `tokio::net::UnixStream`
- `#[cfg(windows)]` — use TCP loopback (`127.0.0.1:0`) or `tokio::net::windows::named_pipe`

Both the Rust host and the .NET sidecar MUST use the same transport on each platform. Win32 builds failing to compile due to `UnixStream` is a hard blocker.

## 11. Required Secrets

| Secret | Purpose |
|---|---|
| `BREW_SCOOP_PAT` | PAT with `contents:write` on `Nimblesite/homebrew-tap` and `Nimblesite/scoop-bucket` |
| `VSCE_PAT` | VS Code Marketplace publish token |

## 11. CI Smoke Tests

Every PR:
- Validates `shipwright.json` with `shipwright-validate-manifest`
- Runs `dotnet publish --no-self-contained` on both sidecars
- Verifies `bin/<platform>/sharplsp[.exe]` exists in the staged VSIX layout
- Verifies `bin/all/sharplsp-sidecar-csharp` exists in the staged VSIX layout
- Verifies `bin/all/sharplsp-sidecar-fsharp` exists in the staged VSIX layout
- Runs `sharplsp --version`, `sharplsp-sidecar-csharp --version`, `sharplsp-sidecar-fsharp --version`

## 12. Forbidden Patterns

- `https.get(...)` or `fetch(...)` for binary downloads
- `dotnet tool install` / `dotnet tool update` as a distribution mechanism for VSIX users
- Treating either sidecar as optional — both are required, both crash activation if missing
- Writing any component binary into `~/.local/`, temp dirs, or paths not managed by Shipwright
- Hand-rolling binary resolution — use `activateDeploymentToolkit` exclusively
- Skipping version verification on activation
- Shipping a single universal VSIX containing all platform binaries
- `SelfContained=true` in any sidecar `.csproj`/`.fsproj`
- Graceful degradation when a required component is missing — crash with a clear error
