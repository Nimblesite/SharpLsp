---
name: ci-prep
description: Prepare the Forge codebase for CI. Runs all checks from the CI pipeline (Rust lint, .NET format/lint, TypeScript format/lint) and loops until every single check passes. Use before submitting a PR or when you want to ensure CI will pass.
argument-hint: "[optional focus area: rust | dotnet | vscode | all]"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

# CI Prep — Get Forge PR-Ready

You MUST NOT STOP until every check passes.

## Checklist (derived from `.github/workflows/ci.yml` and `Makefile`)

The CI pipeline has three independent lint jobs and one test job. Your checklist:

1. **Rust fmt** — `cargo fmt --check`
2. **Rust clippy** — `cargo clippy --profile debug -- -D warnings`
3. **TypeScript prettier** — `cd editors/vscode && npx prettier@3 --check 'src/**/*.ts'`
4. **TypeScript ESLint** — `npm run lint:eslint --prefix editors/vscode`
5. **TypeScript tsc** — `npm run typecheck --prefix editors/vscode`

> Note: .NET checks (`dotnet csharpier`, `make lint-dotnet`) require the full .NET SDK and are skipped if `dotnet` is not available. Website build is not in CI and is skipped.

## Step 1: Confirm Prerequisites

```bash
which cargo && cargo --version
which dotnet && dotnet --version || echo "SKIP: dotnet not available"
node --version && npm --version
```

If `dotnet` is available, add to your checklist:
- **dotnet tool restore** — `dotnet tool restore`
- **.NET csharpier format** — `dotnet csharpier check sidecars/`
- **.NET build/lint** — `dotnet build sidecars/Forge.Sidecars.sln --configuration Debug -warnaserror`

## Step 2: Coordinate with Other Agents

Before making changes:
1. Check TMC status for active agents and locked files
2. Do NOT edit files locked by other agents
3. Lock files before editing them
4. Broadcast what you are doing

## Step 3: The Loop

Work through the checklist in order. For each check:

1. Run the exact command
2. If it passes → move to the next check
3. If it fails → **FIX IT**. Do NOT suppress warnings, skip checks, add `allow(clippy::...)`, or lower strictness. Fix the actual code.
4. Re-run the check to confirm the fix
5. Move on

### Commands

```bash
# 1. Rust format (fix)
cargo fmt

# 1. Rust format (check only)
cargo fmt --check

# 2. Rust clippy
cargo clippy --profile debug -- -D warnings

# 3. TypeScript prettier (fix)
cd editors/vscode && npx prettier@3 --write 'src/**/*.ts'

# 3. TypeScript prettier (check only)
cd editors/vscode && npx prettier@3 --check 'src/**/*.ts'

# 4. TypeScript ESLint
npm run lint:eslint --prefix editors/vscode

# 5. TypeScript tsc
npm run typecheck --prefix editors/vscode

# --- dotnet (if available) ---

# dotnet tool restore
dotnet tool restore

# .NET csharpier (fix)
dotnet csharpier sidecars/

# .NET csharpier (check)
dotnet csharpier check sidecars/

# .NET build with warnings-as-errors
dotnet build sidecars/Forge.Sidecars.sln --configuration Debug -warnaserror
```

### Fix Rules

- **Rust clippy violations**: Fix the code. If clippy flags an issue, address the root cause. Never add `#[allow(clippy::...)]` without an extraordinary justification.
- **Rust fmt**: Run `cargo fmt` to auto-fix, then verify with `cargo fmt --check`.
- **TypeScript prettier**: Run `npx prettier@3 --write 'src/**/*.ts'` to auto-fix formatting.
- **TypeScript ESLint**: Fix lint errors in the source. Never add `// eslint-disable`.
- **TypeScript tsc**: Fix type errors. Never use `any` to silence a type error.
- **.NET csharpier**: Run `dotnet csharpier sidecars/` to auto-fix.
- **.NET build warnings**: Fix the actual warning in the source code.

### When to Keep Looping

After reaching the end of the checklist, **go back to the start and run it again**. A fix for one check may break an earlier check. Keep looping until you get a complete clean pass — every check green on the first try with nothing fixed during that pass.

**Do NOT stop after one loop. Keep going until a full pass is clean.**

## Step 4: Final Coordination

1. Broadcast on TMC that CI prep is complete and all checks pass
2. Release any locks you hold
3. Report final status to the user — list each passing check with its output

## Hard Rules

- NEVER stop with failing checks. Loop until everything is green.
- NEVER add `allow(clippy::...)`, `// eslint-disable`, `#pragma warning disable`, or similar suppressions.
- NEVER remove assertions or skip tests.
- NEVER use `any` in TypeScript to silence type errors.
- Fix the CODE, not the checks.
- If stuck on the same failure after 3 attempts, ask the user for help. Do NOT silently give up.
- Always coordinate with other agents via TMC.
