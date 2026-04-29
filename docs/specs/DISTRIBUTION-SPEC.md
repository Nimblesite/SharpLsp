# Distribution Specification

This document is the canonical specification for how SharpLsp is distributed.
All statements below are normative requirements, not suggestions.

## 1. Components

SharpLsp has three executable components. All three MUST be present and version-matched for full functionality.

| Component ID | Binary | Required | Distribution |
|---|---|---|---|
| `sharplsp` | `sharplsp` / `sharplsp.exe` | **YES** — blocks activation | Bundled in per-platform VSIX |
| `sharplsp-sidecar-csharp` | `sharplsp-sidecar-csharp` | **YES** — blocks activation | dotnet global tool (`SharpLsp.Sidecar.CSharp`) |
| `sharplsp-sidecar-fsharp` | `sharplsp-sidecar-fsharp` | No — degrades gracefully | dotnet global tool (`SharpLsp.Sidecar.FSharp`) |

All three are verified by Shipwright on every VS Code activation via `activationVerifies` in `shipwright.json`.

## 2. Primary Distribution Model — Bundled VSIX

The `sharplsp` binary is **bundled inside every per-platform VSIX**. A user who installs the VS Code extension gets the LSP server with zero additional steps. The sidecars are NOT bundled — they install separately as dotnet global tools.

### Per-Platform VSIX Layout

A separate VSIX is published for each platform. Each VSIX contains the pre-built `sharplsp` binary at:

```
bin/<platform>/sharplsp        (Unix)
bin/<platform>/sharplsp.exe    (Windows)
```

| Platform VSIX | Binary path inside VSIX |
|---|---|
| `darwin-arm64` | `bin/darwin-arm64/sharplsp` |
| `darwin-x64` | `bin/darwin-x64/sharplsp` |
| `linux-x64` | `bin/linux-x64/sharplsp` |
| `linux-arm64` | `bin/linux-arm64/sharplsp` |
| `win32-x64` | `bin/win32-x64/sharplsp.exe` |
| `win32-arm64` | `bin/win32-arm64/sharplsp.exe` |

## 3. Shipwright Resolution — All Three Components

Resolution is driven by the `sources` array per component in `shipwright.json`. The `activateDeploymentToolkit` call verifies all three on activation.

### `sharplsp` (LSP server — bundled in VSIX)

Sources: `["user-setting", "env", "bundled", "path", "pkgmgr"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.lspPath` VS Code setting — absolute path; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_LSP_PATH` (full path) or `SHARPLSP_BINARY_DIR` (directory); version drift = `ok-with-warning` |
| 3 | **`bundled`** | `bin/<platform>/sharplsp[.exe]` inside `extensionPath` ← **DEFAULT for all users**; version drift = `ok-with-warning` |
| 4 | `path` | `sharplsp` on `$PATH`; exact version match required |
| 5 | `pkgmgr` | Shows modal prompt: `brew install nimblesite/tap/sharplsp` / `scoop install nimblesite/sharplsp` |

### `sharplsp-sidecar-csharp` (C# Roslyn sidecar — dotnet global tool, REQUIRED)

Sources: `["user-setting", "env", "path", "dotnet-tool"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.csharpSidecarPath` VS Code setting; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_CSHARP_SIDECAR_PATH` (full path) |
| 3 | `path` | `sharplsp-sidecar-csharp` on `$PATH`; exact version match required |
| 4 | `dotnet-tool` | `sharplsp-sidecar-csharp` installed via `dotnet tool install -g SharpLsp.Sidecar.CSharp`; version mismatch = prompt `dotnet tool update -g SharpLsp.Sidecar.CSharp --version <expected>` |

**Required = true.** If unresolved, activation blocks. The user MUST install:
```
dotnet tool install -g SharpLsp.Sidecar.CSharp
```

### `sharplsp-sidecar-fsharp` (F# FCS sidecar — dotnet global tool, OPTIONAL)

Sources: `["user-setting", "env", "path", "dotnet-tool"]`

| Priority | Source | How |
|---|---|---|
| 1 | `user-setting` | `sharplsp.fsharpSidecarPath` VS Code setting; version mismatch = hard error |
| 2 | `env` | `SHARPLSP_FSHARP_SIDECAR_PATH` (full path) |
| 3 | `path` | `sharplsp-sidecar-fsharp` on `$PATH`; exact version match required |
| 4 | `dotnet-tool` | `sharplsp-sidecar-fsharp` installed via `dotnet tool install -g SharpLsp.Sidecar.FSharp`; version mismatch = prompt update |

**Required = false.** If unresolved, activation continues — C# features still work. F# features degrade gracefully. Install with:
```
dotnet tool install -g SharpLsp.Sidecar.FSharp
```

## 4. Version Matching Semantics

From the Shipwright `resolve()` source:

| Source | Version mismatch behaviour |
|---|---|
| `user-setting` | Hard error — activation blocked |
| `env` | `ok-with-warning` — activation continues |
| `bundled` | `ok-with-warning` — activation continues |
| `path` | Skipped (no match) — falls through to next source |
| `dotnet-tool` | Prompt modal with `dotnet tool update -g` command |
| `pkgmgr` | Prompt modal with `brew install` / `scoop install` command |

Prompts show a modal — they do NOT run commands automatically.

## 5. Version Invariant

`Cargo.toml` `version` is the single source of truth. The release workflow stamps the tag version into:

1. `Cargo.toml` (at build time only, not committed)
2. `editors/vscode/package.json` (at build time only)
3. Sidecar `.nupkg` package versions (`-p:PackageVersion`)
4. Assembly `InformationalVersion` for sidecar `--version` output
5. Homebrew formula and Scoop manifest versions

All five MUST match byte-for-byte for a release to be valid.

### `--version` output format

| Binary | Expected stdout |
|---|---|
| `sharplsp --version` | `sharplsp <semver>` |
| `sharplsp-sidecar-csharp --version` | `sharplsp-sidecar-csharp <semver>` |
| `sharplsp-sidecar-fsharp --version` | `sharplsp-sidecar-fsharp <semver>` |

The first whitespace-delimited token MUST exactly match the component `id` in `shipwright.json`. Shipwright uses this for name validation.

## 6. Editor Extension Contract

The VS Code extension uses `@nimblesite/shipwright-vscode` (`activateDeploymentToolkit`) to resolve all three components. The extension MUST:

1. **Never hand-roll binary resolution** — use `activateDeploymentToolkit` exclusively.
2. **Never download binaries over HTTPS** — `sharplsp` ships in the VSIX; sidecars install via `dotnet tool`.
3. **Block activation** if `sharplsp` (required=true) returns `status: "error"`.
4. **Block activation** if `sharplsp-sidecar-csharp` (required=true) returns `status: "error"`.
5. **Continue with degraded F# support** if `sharplsp-sidecar-fsharp` (required=false) is unresolved.
6. **Pass the Shipwright-resolved path** to `LanguageClient` — never hardcode a binary path.

## 7. Optional PATH Install

Users who want `sharplsp` on their system PATH outside VS Code may install via:

- **macOS/Linux**: `brew install nimblesite/tap/sharplsp`
- **Windows**: `scoop install nimblesite/sharplsp`

This is entirely optional. The bundled VSIX binary is sufficient for VS Code users.

## 8. Release Workflow

Tag-triggered (`v*`). Jobs:

1. **`build-sharplsp`** — matrix: 6 targets (darwin-arm64, darwin-x64, linux-x64, linux-arm64, win32-x64, win32-arm64). One binary archive per platform.
2. **`pack-sidecars`** — single ubuntu job. `dotnet pack` both sidecars as framework-dependent tools. Produces 2 nupkgs.
3. **`build-vsix`** — for each platform, stages the matching `sharplsp` binary at `editors/vscode/bin/<platform>/sharplsp[.exe]`, runs `vsce package --target <platform>`. Produces 6 per-platform `.vsix` files.
4. **`release`** — creates GitHub release with all archives and VSIXs, pushes nupkgs to NuGet.org, updates Homebrew tap, updates Scoop bucket, publishes VSIXs to VS Code Marketplace.

## 9. Required Secrets

| Secret | Purpose |
|---|---|
| `BREW_SCOOP_PAT` | PAT with `contents:write` on `Nimblesite/homebrew-tap` and `Nimblesite/scoop-bucket` |
| `NUGET_API_KEY` | Push rights to `SharpLsp.Sidecar.*` on nuget.org |
| `VSCE_PAT` | VS Code Marketplace publish token |

## 10. CI Smoke Tests

Every PR:
- Validates both `shipwright.json` manifests with `shipwright-validate-manifest`
- Runs `dotnet pack` on both sidecars (without publishing)
- Verifies `bin/<platform>/sharplsp[.exe]` exists in the staged VSIX layout
- Runs `sharplsp --version` and `sharplsp --version --json` to confirm output format
- Runs `sharplsp-sidecar-csharp --version` and `sharplsp-sidecar-fsharp --version`

## 11. Forbidden Patterns

- `https.get(...)` or `fetch(...)` for binary downloads
- Writing any component binary into `~/.local/`, temp dirs, or paths not managed by Shipwright
- Hand-rolling binary resolution — use `activateDeploymentToolkit` exclusively
- Skipping version verification on activation
- Shipping a single universal VSIX containing all platform binaries
- `SelfContained=true` in any sidecar `.csproj`/`.fsproj`
