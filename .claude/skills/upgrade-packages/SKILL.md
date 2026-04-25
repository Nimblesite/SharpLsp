---
name: upgrade-packages
description: Upgrades all project dependencies to latest compatible versions. Use when the user says "upgrade packages", "update deps", "bump dependencies", or "upgrade dependencies".
argument-hint: "[--check-only] [--major] [specific-package-name]"
---
<!-- agent-pmo:2efd847 -->

# Upgrade Packages

Upgrade all project dependencies to their latest compatible versions across all languages in the repo.

## Arguments

- `--check-only` — List outdated packages without upgrading. Stop after Step 2.
- `--major` — Include major version bumps (breaking changes). Without this flag, stay within semver-compatible ranges.
- Any other argument is treated as a specific package name to upgrade (instead of all packages).

## Step 1 — Detect Package Managers

Scan the repo for these package ecosystems:

| Marker File | Ecosystem | Location |
|---|---|---|
| `Cargo.toml` (workspace) | Rust (cargo) | Repo root |
| `package.json` / `package-lock.json` | Node.js (npm) | `editors/vscode/` |
| `*.csproj` / `*.fsproj` / `Directory.Build.props` | C#/F# (.NET / NuGet) | `sidecars/Forge.Sidecars.sln` |

## Step 2 — List Outdated Packages

Run the appropriate command to list what's outdated BEFORE upgrading anything. Show the user what will change.

### Rust (cargo)
```bash
cargo outdated --root-deps-only --workspace
cargo update --dry-run
```
If `cargo-outdated` is not installed: `cargo install cargo-outdated`

**Read the docs:** https://doc.rust-lang.org/cargo/commands/cargo-update.html

### Node.js (npm)
```bash
npm outdated --prefix editors/vscode
```

**Read the docs:** https://docs.npmjs.com/cli/v10/commands/npm-update

### C#/.NET (NuGet)
```bash
dotnet list sidecars/Forge.Sidecars.sln package --outdated
```
For transitive dependencies too: `dotnet list sidecars/Forge.Sidecars.sln package --outdated --include-transitive`

**Read the docs:** https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-list-package

If `--check-only` was passed, **stop here** and report the outdated list.

## Step 3 — Read the official upgrade docs

**Before running any upgrade command, you MUST fetch and read the official documentation URL listed above for the detected package manager.** Use WebFetch to retrieve the page. This ensures you use the correct flags and understand the behavior. Do not guess at flags or options from memory.

For any package with a major version bump (when `--major` is passed), also check the package's changelog or release notes for breaking changes before upgrading.

## Step 4 — Run Upgrades

If a specific package name was given as an argument, upgrade only that package.

### Rust
```bash
cargo update                          # semver-compatible updates
# --major flag:
cargo update --breaking               # major version bumps (cargo 1.84+)
```
For workspace members, run from workspace root.

### Node.js (npm)
```bash
npm update --prefix editors/vscode                            # semver-compatible
# --major flag:
npx npm-check-updates -u --packageFile editors/vscode/package.json && npm install --prefix editors/vscode
```

### C#/.NET (NuGet)
```bash
dotnet outdated --upgrade sidecars/Forge.Sidecars.sln
```
If `dotnet-outdated` tool is not installed: `dotnet tool install -g dotnet-outdated-tool`

**Read the docs:** https://github.com/dotnet-outdated/dotnet-outdated

Shared NuGet package versions live in `Directory.Build.props` — check there first and update centrally when possible, rather than editing individual `.csproj`/`.fsproj` files.

## Step 5 — Verify the upgrade

After upgrading, run the full CI pipeline:

```bash
make ci
```

If tests fail:
1. Read the failure output carefully
2. Check the changelog / migration guide for the upgraded packages (fetch the release notes URL if available)
3. Fix breaking changes in the code
4. Re-run `make ci`
5. If stuck after 3 attempts on the same failure, report it to the user with the error details and the package that caused it

## Step 6 — Report

Provide a summary:

- Packages upgraded (old version -> new version)
- Packages skipped (and why, e.g., major version bump without `--major` flag)
- Build/test result after upgrade
- Any breaking changes that were fixed
- Any packages that could not be upgraded (with error details)

## Rules

- **Always list outdated packages first** before upgrading anything
- **Always read the official docs** for the package manager before running upgrade commands
- **Always run `make ci` after upgrading** to catch breakage immediately
- **Never remove packages** unless they were explicitly deprecated and replaced
- **Never downgrade packages** unless rolling back a broken upgrade
- **Never modify lockfiles manually** (`Cargo.lock`, `package-lock.json`) — let the package manager regenerate them
- **Keep `Cargo.lock` changes** in the same commit as `Cargo.toml` changes
- **Keep `package-lock.json` changes** in the same commit as `package.json` changes
- **`Directory.Build.props`** is the source of truth for shared .NET package versions — update there first
- **If stuck after 3 attempts**, revert and report — do not loop forever
- **Commit nothing** — leave changes in the working tree for the user to review
