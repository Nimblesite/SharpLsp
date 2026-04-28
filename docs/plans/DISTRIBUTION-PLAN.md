# Distribution Implementation Plan

Implementation plan for [DISTRIBUTION-SPEC.md](../specs/DISTRIBUTION-SPEC.md).

## TODO Checklist

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

- [x] `sharplsp-lsp --version` prints `sharplsp-lsp <semver>`
- [x] E2E test validates version output format

### Release workflow (`.github/workflows/release.yml`)

- [x] Job: `build-sharplsp-lsp` — matrix build, single binary archives (no sidecars)
- [x] Job: `pack-sidecars` — framework-dependent `dotnet pack`, 2 nupkgs
- [x] Job: `release` — GitHub release, NuGet publish, Homebrew tap, Scoop bucket
- [ ] Test with a `v*-rc*` tag on a fork

### CI smoke test

- [x] Add `dotnet pack` step to `ci.yml` lint job

### VS Code extension (`install.ts`)

- [x] Replace HTTPS download path with package-manager-driven install
- [x] Version check via `--version` spawn for all three binaries
- [x] Package manager presence checks (brew/scoop/dotnet)
- [x] Modal prompts for install/update
- [x] Remove `downloadToFile`, `extractTarGz`, `downloadAndInstall`
- [x] Remove bundled binary path, `~/.local` staging path

### Makefile

- [x] Add `install-rust` target (copies sharplsp-lsp to `$PREFIX/bin`)
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
