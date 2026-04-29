# Distribute SharpLsp via Homebrew, Scoop, and dotnet tool

## Context

SharpLsp currently ships a single tagged GitHub release containing one monolithic
archive per platform with `bin/sharplsp` + `sidecar-csharp/` + `sidecar-fsharp/`
folders. The VS Code extension downloads that archive and extracts it into
`~/.local/` (see [install.ts:308-384](editors/vscode/src/install.ts#L308-L384)).

The user wants three distinct distribution channels:

1. **Rust `sharplsp` binary** — Homebrew (macOS/Linux) and Scoop (Windows),
   driven by GitHub release assets.
2. **C# and F# sidecars** — published as global `dotnet tool` packages
   (`dotnet tool install -g SharpLsp.Sidecar.CSharp` / `.FSharp`).
3. **VS Code extension (and any future editor extension)** — at activation,
   MUST verify that all three components are installed at the exact version
   the VSIX expects by spawning each binary with `--version` and comparing
   the output to the version in `package.json`. This is non-negotiable: no
   trust-on-presence, no bundled fallback, no version drift.

   If any component is missing or mismatched, the extension MUST actively
   run the matching package manager (`brew` / `scoop` / `dotnet tool install`)
   to install or update it — after prompting the user once with a modal.
   Editor extensions are forbidden from downloading binaries directly; all
   installation goes through Homebrew, Scoop, or the dotnet tool CLI.

The reference is [dart_mutant's release.yml](../../Documents/Code/dart_mutant/.github/workflows/release.yml):
tag-triggered build → GitHub release → auto-update of `Nimblesite/homebrew-tap`
and `Nimblesite/scoop-bucket` via `BREW_SCOOP_PAT`. SharpLsp follows the same
pattern, plus a NuGet.org push for the two sidecars.

## Architecture

```mermaid
flowchart TD
    Tag["git tag v0.1.1"] --> Release[.github/workflows/release.yml]
    Release --> BuildRust["build sharplsp<br/>4 targets"]
    Release --> PackCS["pack SharpLsp.Sidecar.CSharp<br/>as dotnet tool .nupkg"]
    Release --> PackFS["pack SharpLsp.Sidecar.FSharp<br/>as dotnet tool .nupkg"]
    BuildRust --> GH[GitHub Release assets]
    PackCS --> Nuget[NuGet.org]
    PackFS --> Nuget
    GH --> Brew[update Nimblesite/homebrew-tap]
    GH --> Scoop[update Nimblesite/scoop-bucket]
    Brew --> UserBrew["brew install<br/>Nimblesite/tap/sharplsp"]
    Scoop --> UserScoop["scoop install<br/>Nimblesite/sharplsp"]
    Nuget --> UserCS["dotnet tool install -g<br/>SharpLsp.Sidecar.CSharp"]
    Nuget --> UserFS["dotnet tool install -g<br/>SharpLsp.Sidecar.FSharp"]
    UserBrew & UserScoop & UserCS & UserFS --> VSIX[VS Code extension activates]
```

## Runtime resolution in the VSIX

```mermaid
flowchart TD
    Activate[extension activate] --> Expected["read expected version<br/>from package.json"]
    Expected --> CheckLSP["spawn sharplsp --version"]
    CheckLSP --> LSPok{stdout == expected?}
    LSPok -- no --> PromptLSP["modal: install sharplsp via<br/>brew or scoop?"]
    PromptLSP -- yes --> RunPM1["spawn: brew install ... OR<br/>scoop install ..."]
    PromptLSP -- no --> Abort1[abort activation]
    RunPM1 --> CheckLSP
    LSPok -- yes --> CheckCS["spawn sharplsp-sidecar-csharp --version"]
    CheckCS --> CSok{stdout == expected?}
    CSok -- no --> PromptCS["modal: dotnet tool install/update<br/>SharpLsp.Sidecar.CSharp?"]
    PromptCS -- yes --> RunPM2["spawn: dotnet tool update -g<br/>SharpLsp.Sidecar.CSharp --version X"]
    PromptCS -- no --> Abort2[abort activation]
    RunPM2 --> CheckCS
    CSok -- yes --> CheckFS["spawn sharplsp-sidecar-fsharp --version"]
    CheckFS --> FSok{stdout == expected?}
    FSok -- no --> PromptFS["modal: dotnet tool install/update<br/>SharpLsp.Sidecar.FSharp?"]
    PromptFS -- yes --> RunPM3["spawn: dotnet tool update -g<br/>SharpLsp.Sidecar.FSharp --version X"]
    PromptFS -- no --> Abort3[abort activation]
    RunPM3 --> CheckFS
    FSok -- yes --> Launch[launch sharplsp]
```

Rules:

- Version check is ALWAYS by spawning the binary with `--version` and string
  matching against the `package.json` version. No file-presence shortcuts, no
  cached results across sessions.
- The extension is forbidden from downloading binaries directly over HTTPS.
  The only installation paths are `brew`, `scoop`, and `dotnet tool install`.
- If the package manager itself is missing (no `brew` on macOS, no `scoop` on
  Windows, no `dotnet` anywhere), show a modal with a link to install the
  package manager and abort activation.
- Never fall back to a "best effort" older version. Expected version == installed
  version, byte-for-byte. Mismatch = install/update.

## Changes

### 1. Sidecar projects — make them dotnet tools (framework-dependent)

`sidecars/SharpLsp.Sidecar.CSharp/SharpLsp.Sidecar.CSharp.csproj`
`sidecars/SharpLsp.Sidecar.FSharp/SharpLsp.Sidecar.FSharp.fsproj`

Changes:

- **Remove `<SelfContained>true</SelfContained>`.** Sidecars ship as
  framework-dependent dotnet tools. One .nupkg per sidecar, cross-platform.
  Users install `.NET 10 Runtime` as a prerequisite (checked by the VSIX
  before prompting — if `dotnet --version` is missing, send the user to
  dotnet.microsoft.com). Roslyn's `BuildHost-netcore` DLLs and FCS's runtime
  dependencies ship inside the tool package's `tools/<tfm>/any/` directory
  and are resolved at runtime relative to the tool entry point.
- Add `<PackAsTool>true</PackAsTool>`
- Add `<ToolCommandName>sharplsp-sidecar-csharp</ToolCommandName>` / `sharplsp-sidecar-fsharp`
- Add `<PackageId>SharpLsp.Sidecar.CSharp</PackageId>` / `SharpLsp.Sidecar.FSharp`
- Add `<Authors>`, `<Description>`, `<PackageLicenseExpression>`,
  `<RepositoryUrl>`, `<PackageReadmeFile>`
- `<PackageVersion>` injected at pack time from the git tag
  (`dotnet pack -p:PackageVersion=$VERSION`)
- Add `--version` flag handling in `Program.cs` / `Program.fs` that prints
  `sharplsp-sidecar-csharp <version>` (read from the assembly's
  `InformationalVersion` attribute, stamped at pack time) so the extension
  can version-check by spawning the installed tool.

**Risk: will MSBuildWorkspace still work?** `MSBuildWorkspace` spawns
`BuildHost-netcore.dll` as a child process using a path resolved relative to
the Roslyn assembly location. Inside a dotnet global tool, the Roslyn
assemblies are unpacked to
`~/.dotnet/tools/.store/sharplsp.sidecar.csharp/<version>/sharplsp.sidecar.csharp/<version>/tools/net10.0/any/`
and `BuildHost-netcore.dll` is in the same folder as the Roslyn package
dependencies (dotnet pack copies all `PackageReference` content into the
tool output). This should Just Work — but verification step 1 MUST confirm
it against a real `.csproj` before merging. If it genuinely breaks (e.g. FCS
using `Assembly.Location` returning a path that no longer contains FSharp.Core),
the fix is to flip `<RollForward>LatestMajor</RollForward>` and ensure
`<CopyLocalLockFileAssemblies>true</CopyLocalLockFileAssemblies>` so every
transitive dep lands next to the tool DLL. Still dotnet tool. No self-contained.

### 2. Rust binary — already has `--version`, confirm via `sharplsp --version`

No changes needed in the Rust source. Already verified at
[install.ts:74-91](editors/vscode/src/install.ts#L74-L91).

### 3. `.github/workflows/release.yml` — rewrite

Replace the current monolithic archive job with:

**Job A: `build-sharplsp`** (matrix: 4 targets)
- Build `cargo build --release --target <target>`
- Package single binary as `sharplsp-<tag>-<target>.{tar.gz,zip}` (no
  sidecar dirs — just the binary, like dart_mutant)
- Upload artifact

**Job B: `pack-sidecars`** (single ubuntu job — framework-dependent, no RID matrix)
- `dotnet pack sidecars/SharpLsp.Sidecar.CSharp -p:PackageVersion=<version>
   -c Release -o nupkgs` → one cross-platform `.nupkg`
- Same for `SharpLsp.Sidecar.FSharp`
- Total: 2 nupkgs per release
- Upload nupkg artifacts

**Job C: `release`** (needs [A, B])
- `gh release create` with all tar.gz/zip assets (sharplsp only)

**Job D: `publish-nuget`** (needs [B])
- `dotnet nuget push *.nupkg --api-key ${{ secrets.NUGET_API_KEY }}
   --source https://api.nuget.org/v3/index.json`

**Job E: `update-homebrew`** (needs [release])
- Checkout `Nimblesite/homebrew-tap` with `BREW_SCOOP_PAT`
- Download macOS arm64 + macOS x64 + linux x64 tar.gz assets, sha256 each
- Generate `Formula/sharplsp.rb` with `on_macos {on_arm / on_intel}` and
  `on_linux { on_intel }` blocks, one url+sha256 per block
- `def install; bin.install "sharplsp"; end`
- `test do; assert_match "sharplsp", shell_output("#{bin}/sharplsp --version"); end`
- Commit and push

**Job F: `update-scoop`** (needs [release])
- Checkout `Nimblesite/scoop-bucket` with `BREW_SCOOP_PAT`
- Download win x64 zip, sha256 it
- Write `bucket/sharplsp.json` with `architecture."64bit".{url,hash,bin}`,
  `checkver.github`, `autoupdate.architecture."64bit".url` template
- Commit and push

### 4. VS Code extension — rewrite `editors/vscode/src/install.ts`

Replace `ensureBinaries` and the entire download path
([install.ts:107-306](editors/vscode/src/install.ts#L107-L306)) with a
verify-then-install-via-package-manager layer.

**Version check (mandatory, always via `--version`):**

```ts
function getVersion(command: string): string | undefined {
    // spawnSync command --version, parse first line "<name> <semver>"
    // return semver or undefined on any failure (not found, crash, parse)
}
```

This is called for all three: `sharplsp`, `sharplsp-sidecar-csharp`,
`sharplsp-sidecar-fsharp`. No file-existence checks, no fallbacks.

**Package-manager-driven install (the only install path):**

```ts
// Per-binary install/update command keyed by platform.
// No HTTPS downloads, no tarball extraction, no ~/.local staging.
const INSTALL_COMMANDS = {
    "sharplsp": {
        darwin: ["brew", "install", "Nimblesite/tap/sharplsp"],
        linux:  ["brew", "install", "Nimblesite/tap/sharplsp"],
        win32:  ["scoop", "install", "Nimblesite/sharplsp"],
    },
    "sharplsp-sidecar-csharp": {
        all: ["dotnet", "tool", "update", "-g", "SharpLsp.Sidecar.CSharp",
              "--version", EXPECTED],
    },
    "sharplsp-sidecar-fsharp": {
        all: ["dotnet", "tool", "update", "-g", "SharpLsp.Sidecar.FSharp",
              "--version", EXPECTED],
    },
};
```

- `update` (not `install`) is used so the same command works for both first
  install and version bump. `dotnet tool update -g --version X` installs if
  absent and re-pins if present.
- For `sharplsp` on Scoop, version pinning uses `scoop install sharplsp@X`
  if the bucket manifest supports it, otherwise `scoop update sharplsp`.

**Flow for each binary:**

1. `getVersion(binary)` → compare to `expectedVersion()`
2. If match: use it, done.
3. If mismatch: show modal with OK/Cancel — "SharpLsp needs to install
   `<binary>` at version `<X>`. Run `<command>`?"
4. OK → spawn the command, stream stdout/stderr to an Output Channel so
   the user sees progress. On exit, re-run step 1.
5. Cancel → throw, activation aborts.

**Preflight — package manager presence:**

Before running any install command, run `getVersion("brew")` /
`getVersion("scoop")` / `getVersion("dotnet")`. If the required package
manager is missing, show a modal with a link to the install page and
abort. Do not offer to install package managers automatically.

**Deletions:**

- `downloadAndInstall`, `downloadToFile`, `extractTarGz`, `platformRid`,
  `bundledBinaryPath`, and the whole GitHub-release HTTPS path.
- The `bin/` VSIX bundling path and the `~/.local/lib/sharplsp/` staging from
  both the Makefile `install` target and `.github/workflows/test-vscode.yml`
  (recent commits `c6f29f0` and `e1dd2ca` become partially obsolete).

**Forbidden patterns (encoded as lint / code review):**

- `https.get(...)` or `fetch(...)` for binary downloads
- Any path that writes executables into `~/.local/`, `extensionPath/bin/`,
  or a temp dir with intent to execute
- Any "skip version check if binary exists" shortcut

### 5. Makefile — simplify `install` target

`Makefile:370-383` — the `install` target currently stages sharplsp +
sidecars into `$PREFIX`. Replace with:

- `install-rust`: just copies `sharplsp` to `$PREFIX/bin` (for local dev)
- `install-sidecars`: runs `dotnet tool install -g` from locally packed
  nupkgs so contributors can test the tool install flow end-to-end
- Drop `~/.local/lib/sharplsp/` entirely. Sidecars now live wherever
  `dotnet tool` puts them (`~/.dotnet/tools` on macOS/Linux,
  `%USERPROFILE%\.dotnet\tools` on Windows).

### 6. Docs

New: `docs/specs/DISTRIBUTION-SPEC.md` — canonical spec for how SharpLsp is
distributed. MUST state the following as normative requirements (not
suggestions):

1. **Three channels, no alternatives.**
   - `sharplsp` → Homebrew (macOS/Linux) and Scoop (Windows).
   - `SharpLsp.Sidecar.CSharp` → dotnet global tool on NuGet.org.
   - `SharpLsp.Sidecar.FSharp` → dotnet global tool on NuGet.org.
   - Sidecars are **framework-dependent** dotnet tools. `SelfContained=true`
     is forbidden in sidecar csproj/fsproj files.

2. **Version invariant.** `Cargo.toml` `version` is the single source of
   truth. The release workflow stamps the tag version into:
   - `Cargo.toml` (at build time only, not committed)
   - `editors/vscode/package.json` (at build time only)
   - Sidecar `.nupkg` package versions
   - Assembly `InformationalVersion` for sidecar `--version` output
   All five must match byte-for-byte for a release to be valid.

3. **Editor extension contract.** Any editor extension (VS Code today,
   Zed/JetBrains/Neovim in the future) MUST:
   - Check all three binary versions on activation by spawning each with
     `--version` and string-matching against the extension's own version.
   - NEVER download binaries directly over HTTPS. The only installation
     mechanisms are `brew`, `scoop`, and `dotnet tool install`/`update`.
   - On mismatch, prompt the user once (modal) and then run the matching
     package-manager command, streaming output to a visible log.
   - Abort activation on user cancel or install failure — never fall back
     to a degraded mode or older version.

4. **Tap/bucket repo layout.** `Nimblesite/homebrew-tap` contains
   `Formula/sharplsp.rb`. `Nimblesite/scoop-bucket` contains
   `bucket/sharplsp.json`. Both are auto-updated by the release workflow
   using `BREW_SCOOP_PAT`. Manual edits are forbidden.

5. **Required secrets on `Nimblesite/SharpLsp`:** `BREW_SCOOP_PAT` (PAT with
   `contents:write` on both tap repos), `NUGET_API_KEY` (push rights to
   `SharpLsp.Sidecar.*` on nuget.org).

New: `docs/plans/DISTRIBUTION-PLAN.md` — TODO checklist mirroring the
changes in this plan file.

Update: `docs/specs/SHARPLSP-SPEC.md` — add a short "Distribution" section
linking to `DISTRIBUTION-SPEC.md`.

## Critical files

- [.github/workflows/release.yml](.github/workflows/release.yml) — rewrite
- [editors/vscode/src/install.ts](editors/vscode/src/install.ts) — gut and replace
- [sidecars/SharpLsp.Sidecar.CSharp/SharpLsp.Sidecar.CSharp.csproj](sidecars/SharpLsp.Sidecar.CSharp/SharpLsp.Sidecar.CSharp.csproj) — add `PackAsTool`
- [sidecars/SharpLsp.Sidecar.FSharp/SharpLsp.Sidecar.FSharp.fsproj](sidecars/SharpLsp.Sidecar.FSharp/SharpLsp.Sidecar.FSharp.fsproj) — add `PackAsTool`
- [sidecars/SharpLsp.Sidecar.CSharp/Program.cs](sidecars/SharpLsp.Sidecar.CSharp/Program.cs) — add `--version`
- [sidecars/SharpLsp.Sidecar.FSharp/Program.fs](sidecars/SharpLsp.Sidecar.FSharp/Program.fs) — add `--version`
- [Makefile](Makefile) — simplify `install` target
- `docs/specs/DISTRIBUTION-SPEC.md` — new
- `docs/plans/DISTRIBUTION-PLAN.md` — new

## External prerequisites

These must exist before the release workflow will succeed. Create them
before merging the changes:

- GitHub repo `Nimblesite/homebrew-tap` (empty, default branch `main`)
- GitHub repo `Nimblesite/scoop-bucket` (empty, default branch `main`)
- PAT with `contents:write` on both repos → add as `BREW_SCOOP_PAT` secret
  on `Nimblesite/SharpLsp`
- NuGet.org account + API key with push rights to `SharpLsp.Sidecar.*` →
  add as `NUGET_API_KEY` secret
- Reserve package IDs `SharpLsp.Sidecar.CSharp` and `SharpLsp.Sidecar.FSharp` on
  nuget.org via a manual 0.0.1-preview push, to prevent squatting

## Verification

1. **Local dry-run of sidecar packaging**
   ```
   dotnet pack sidecars/SharpLsp.Sidecar.CSharp -p:PackageVersion=0.1.1 \
     -p:RuntimeIdentifier=osx-arm64 -o /tmp/nupkgs
   dotnet tool install -g --add-source /tmp/nupkgs SharpLsp.Sidecar.CSharp
   sharplsp-sidecar-csharp --version   # must print "sharplsp-sidecar-csharp 0.1.1"
   ```
   Confirms `PackAsTool` + `SelfContained` + multi-RID strategy actually works.
   **If this fails**, the whole dotnet-tool channel is invalid and we need
   to reconsider (fallback: ship sidecars as GitHub release tarballs beside
   sharplsp, verified by path on PATH).

2. **VSIX verification path**
   - Build VSIX locally with version `0.1.1`
   - Install sidecars at `0.1.0` and `sharplsp` at `0.1.1`
   - Activate extension in a fresh VS Code window
   - Expect: activation fails fast with a modal showing the exact
     `dotnet tool update -g SharpLsp.Sidecar.CSharp --version 0.1.1` command
   - Install matching versions, reactivate — expect clean startup

3. **Tag-driven end-to-end**
   - Push tag `v0.1.1-rc1` to a test fork
   - Observe: `release` workflow succeeds, GitHub release created,
     `homebrew-tap` and `scoop-bucket` forks receive commits, nupkgs
     appear on nuget.org
   - On a clean macOS VM: `brew install Nimblesite/tap/sharplsp` + both
     `dotnet tool install` commands → VS Code extension activates cleanly
   - On a clean Windows VM: same via scoop

4. **CI smoke test**
   - Add a job to `ci.yml` that runs `dotnet pack` on both sidecars
     (without publishing) on every PR, so packaging regressions are caught
     before tag time.
