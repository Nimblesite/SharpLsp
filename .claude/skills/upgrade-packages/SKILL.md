---
name: upgrade-packages
description: Upgrades all project dependencies to latest compatible versions. Use when the user says "upgrade packages", "update deps", "bump dependencies", or "upgrade dependencies".
argument-hint: "[--check-only] [--major] [specific-package-name]"
---
<!-- agent-pmo:3140e31 -->

# Upgrade Packages

Upgrade all project dependencies to their latest compatible versions across all languages in the repo.

## Arguments

- `--check-only` — List outdated packages without upgrading
- `--major` — Include major version bumps (breaking changes)
- Any other argument is treated as a specific package name to upgrade

## Step 1 — Detect Package Managers

Scan the repo root and subdirectories for:

- `Cargo.toml` → Rust (cargo)
- `package.json` / `package-lock.json` → Node.js (npm)
- `*.csproj` / `*.fsproj` / `*.sln` → C#/F# (.NET / NuGet)

## Step 2 — List Outdated Packages

### Rust (cargo)
```bash
cargo outdated --root-deps-only
```
If `cargo-outdated` is not installed: `cargo install cargo-outdated`

### Node.js (npm)
```bash
npm outdated --prefix editors/vscode
```

### C#/.NET (NuGet)
```bash
dotnet list sidecars/Forge.Sidecars.sln package --outdated
```

If `--check-only` was passed, report the outdated packages and stop here.

## Step 3 — Read Official Docs for Major Bumps

For any package with a major version bump available (and `--major` was passed or a specific package was named):
1. Check the package's changelog or release notes
2. Note breaking changes that affect the codebase
3. Plan the migration before running the upgrade

## Step 4 — Run Upgrades

### Rust
```bash
cargo update
```
For major bumps: manually edit version in `Cargo.toml`, then `cargo update`.

### Node.js
```bash
npm update --prefix editors/vscode
```
For major bumps: `npm install <package>@latest --prefix editors/vscode`

### C#/.NET
```bash
dotnet outdated --upgrade sidecars/Forge.Sidecars.sln
```
If `dotnet-outdated` tool is not installed: `dotnet tool install -g dotnet-outdated-tool`

## Step 5 — Verify

1. Run `make build` — must compile cleanly
2. Run `make test` — all tests must pass with coverage thresholds met
3. Run `make lint` — no new lint violations

If any step fails:
- Identify which package upgrade caused the failure
- Fix the code to work with the new version
- If the fix is non-trivial, revert that specific package and report it

## Step 6 — Report

List:
- Packages upgraded (old version → new version)
- Packages skipped (and why)
- Any breaking changes encountered and how they were resolved
- Test results after upgrade

## Rules

- Never remove packages — only upgrade
- Never downgrade packages
- Never manually edit lockfiles (`Cargo.lock`, `package-lock.json`)
- Always run tests after upgrading
- If a specific package was requested, only upgrade that package
- Keep `Cargo.lock` changes in the same commit as `Cargo.toml` changes
