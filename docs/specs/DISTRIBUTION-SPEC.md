# Distribution Specification

This document is the canonical specification for how Forge is distributed.
All statements below are normative requirements, not suggestions.

## 1. Three Channels, No Alternatives

| Component | Channel | Package ID |
|-----------|---------|------------|
| `forge-lsp` | Homebrew (macOS/Linux), Scoop (Windows) | `Nimblesite/tap/forge-lsp` / `Nimblesite/forge-lsp` |
| C# sidecar | dotnet global tool on NuGet.org | `Forge.Sidecar.CSharp` |
| F# sidecar | dotnet global tool on NuGet.org | `Forge.Sidecar.FSharp` |

Sidecars are **framework-dependent** dotnet tools. `SelfContained=true` is
forbidden in sidecar `.csproj`/`.fsproj` files. Users install the .NET
runtime as a prerequisite.

## 2. Version Invariant

`Cargo.toml` `version` is the single source of truth. The release workflow
stamps the tag version into:

1. `Cargo.toml` (at build time only, not committed)
2. `editors/vscode/package.json` (at build time only)
3. Sidecar `.nupkg` package versions (`-p:PackageVersion`)
4. Assembly `InformationalVersion` for sidecar `--version` output
5. Homebrew formula and Scoop manifest versions

All five MUST match byte-for-byte for a release to be valid.

## 3. Editor Extension Contract

Any editor extension (VS Code today, Zed/JetBrains/Neovim in the future) MUST:

1. **Check all three binary versions on activation** by spawning each with
   `--version` and string-matching against the extension's own version.
2. **NEVER download binaries directly over HTTPS.** The only installation
   mechanisms are `brew`, `scoop`, and `dotnet tool install`/`update`.
3. **On mismatch**, prompt the user once (modal) and then run the matching
   package-manager command, streaming output to a visible log.
4. **Abort activation** on user cancel or install failure — never fall back
   to a degraded mode or older version.

### Version check output format

| Binary | Command | Expected stdout |
|--------|---------|-----------------|
| `forge-lsp` | `forge-lsp --version` | `forge-lsp <semver>` |
| C# sidecar | `forge-sidecar-csharp --version` | `forge-sidecar-csharp <semver>` |
| F# sidecar | `forge-sidecar-fsharp --version` | `forge-sidecar-fsharp <semver>` |

### Package manager presence

Before running any install command, check that the required package manager
is available on PATH. If missing, show a modal with a link to the install
page and abort. Do not offer to install package managers automatically.

| Platform | forge-lsp PM | Sidecar PM | PM install URL |
|----------|-------------|-----------|----------------|
| macOS | `brew` | `dotnet` | brew.sh / dotnet.microsoft.com |
| Linux | `brew` | `dotnet` | brew.sh / dotnet.microsoft.com |
| Windows | `scoop` | `dotnet` | scoop.sh / dotnet.microsoft.com |

## 4. Tap/Bucket Repo Layout

- `Nimblesite/homebrew-tap` contains `Formula/forge-lsp.rb`
- `Nimblesite/scoop-bucket` contains `bucket/forge-lsp.json`
- Both are auto-updated by the release workflow using `BREW_SCOOP_PAT`
- Manual edits are forbidden

## 5. Release Workflow

Tag-triggered (`v*`). Three jobs:

1. **`build-forge-lsp`** — matrix: 4 targets (linux-x64, macOS-arm64,
   macOS-x64, win-x64). Single binary per archive (no sidecars bundled).
2. **`pack-sidecars`** — single ubuntu job. `dotnet pack` both sidecars
   as framework-dependent tools. Produces 2 nupkgs.
3. **`release`** — sequential steps: create GitHub release with forge-lsp
   archives, push nupkgs to NuGet.org, update Homebrew tap, update Scoop
   bucket.

## 6. Required Secrets

| Secret | Purpose | Scope |
|--------|---------|-------|
| `BREW_SCOOP_PAT` | PAT with `contents:write` on `Nimblesite/homebrew-tap` and `Nimblesite/scoop-bucket` | `Nimblesite/forge` |
| `NUGET_API_KEY` | Push rights to `Forge.Sidecar.*` on nuget.org | `Nimblesite/forge` |

## 7. CI Smoke Test

Every PR runs `dotnet pack` on both sidecars (without publishing) to catch
packaging regressions before tag time.

## 8. Forbidden Patterns

The following are forbidden in any editor extension:

- `https.get(...)` or `fetch(...)` for binary downloads
- Writing executables into `~/.local/`, `extensionPath/bin/`, or temp dirs
- Skipping version checks when a binary exists on disk
- Falling back to older versions on mismatch
- Bundling binaries inside `.vsix` / extension packages
