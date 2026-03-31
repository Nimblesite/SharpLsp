---
name: ci-prep
description: Prepare the Forge codebase for CI. Runs all checks from the CI pipeline (Rust lint, .NET format/lint, TypeScript format/lint) and loops until every single check passes. Use before submitting a PR or when you want to ensure CI will pass.
argument-hint: "[optional focus area: rust | dotnet | vscode | all]"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

# CI Prep — Get Forge PR-Ready

You MUST NOT STOP until every check passes.

## Checklist (derived from `.github/workflows/ci.yml` and `Makefile`)

- Read the CI script carefully
- Collect all the checks like formatting, linting and testing
- Execute all of them as part of a TODO list
- CRITICAL: **YOU MUST RUN ALL TESTS THAT RUN IN THE CI**
- Check the last GH action run logs for errors. If there were recent errors, you MUST address these

## Step 1: Confirm Prerequisites

- Make sure you have all the components installed to run the checks
- Get the list of ci steps from the ci script and make sure you understand how to run each one locally
[text](../../../.github/workflows/ci.yml)

## Step 2: Coordinate with Other Agents (If running)

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

You are NOT ALLOWED to move to Step 4 until all checks pass without any fixes needed.

## Step 4: Commit/Push

1. Commit and push the changes but DO NOT include yourself as an author
2. Monitor the github action until fails or completes
3. If there is a failure, go back to the beginning of this skill

## Hard Rules

- NEVER stop with failing checks. Loop until everything is green.
- NEVER add `allow(clippy::...)`, `// eslint-disable`, `#pragma warning disable`, or similar suppressions.
- NEVER remove assertions or skip tests.
- NEVER use `any` in TypeScript to silence type errors.
- Fix the CODE, not the checks.
- If stuck on the same failure after 3 attempts, ask the user for help. Do NOT silently give up.
- Always coordinate with other agents via TMC.
