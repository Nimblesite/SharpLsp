---
name: ci-prep
description: Prepares the current branch for CI by running the exact same steps locally and fixing issues. If CI is already failing, fetches the GH Actions logs first to diagnose. Use before pushing, when CI is red, or when the user says "fix ci".
argument-hint: "[--failing] [optional job name to focus on]"
---
<!-- agent-pmo:2efd847 -->

# CI Prep

Prepare the current state for CI. If CI is already failing, fetch and analyze the logs first.

## Arguments

- `--failing` — Indicates a GitHub Actions run is already failing. When present, you MUST execute **Step 1** before doing anything else.
- Any other argument is treated as a job name to focus on (but all failures are still reported).

If `--failing` is NOT passed, skip directly to **Step 2**.

## Step 1 — Fetch failed CI logs (only when `--failing`)

You MUST do this before any other work.

```bash
BRANCH=$(git branch --show-current)
PR_JSON=$(gh pr list --head "$BRANCH" --state open --json number,title,url --limit 1)
```

If the JSON array is empty, **stop immediately**:
> No open PR found for branch `$BRANCH`. Create a PR first.

Otherwise fetch the logs:

```bash
PR_NUMBER=$(echo "$PR_JSON" | jq -r '.[0].number')
gh pr checks "$PR_NUMBER"
RUN_ID=$(gh run list --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RUN_ID"
gh run view "$RUN_ID" --log-failed
```

Read **every line** of `--log-failed` output. For each failure note the exact file, line, and error message. If a job name argument was provided, prioritize that job but still report all failures.

## Step 2 — Analyze the CI workflow

1. Read `.github/workflows/ci.yml` completely. Parse every job and every step.
2. Extract the ordered list of commands the CI actually runs. The Forge CI has these jobs:
   - **lint**: `make lint-rust`, `make lint-zed`, `dotnet csharpier check sidecars/`, `make lint-dotnet`, sidecar dotnet pack smoke test, `cd editors/vscode && npx prettier@3 --check 'src/**/*.ts'`, `make lint-vsix`
   - **test**: `make test-rust`, `make test-zed`, `make test-dotnet`, `xvfb-run -a make test-vsix`
3. Note any environment variables, matrix strategies, or conditional steps that affect execution.

**Do NOT assume the steps are `make lint`, `make test`, `make build`.** The actual CI may run different commands, in a different order. Extract what the CI *actually does*.

## Step 3 — Run each CI step locally, in order

Before making changes, coordinate with other agents via TMC:
1. Check TMC status for active agents and locked files
2. Do NOT edit files locked by other agents
3. Lock files before editing them
4. Broadcast what you are doing

Work through failures in this priority order:

1. **Formatting** — run auto-formatters first to clear noise
2. **Compilation errors** — must compile before lint/test
3. **Lint violations** — fix the code pattern
4. **Runtime / test failures** — fix source code to satisfy the test

For each command extracted from the CI workflow:

1. Run the command exactly as CI would run it (adjusting only for local environment differences like not needing `actions/checkout`).
2. If the step fails, **stop and fix the issues** before continuing to the next step.
3. After fixing, re-run the same step to confirm it passes.
4. Move to the next step only after the current one succeeds.

### Fix Rules

- **Rust clippy violations**: Fix the code. Never add `#[allow(clippy::...)]` without an extraordinary justification.
- **Rust fmt**: Run `cargo fmt` to auto-fix, then verify with `cargo fmt --check`.
- **TypeScript prettier**: Run `cd editors/vscode && npx prettier@3 --write 'src/**/*.ts'` to auto-fix.
- **TypeScript ESLint**: Fix lint errors in the source. Never add `// eslint-disable`.
- **TypeScript tsc**: Fix type errors. Never use `any` to silence a type error.
- **.NET csharpier**: Run `dotnet csharpier sidecars/` to auto-fix.
- **.NET build warnings**: Fix the actual warning in the source code.

### Hard constraints

- **NEVER modify test files** — fix the source code, not the tests
- **NEVER add suppressions** (`#[allow(...)]`, `// eslint-disable`, `#pragma warning disable`)
- **NEVER use `any` in TypeScript** to silence type errors
- **NEVER delete or ignore failing tests**
- **NEVER remove assertions**

### When to Keep Looping

After reaching the end of the checklist, **go back to the start and run it again**. A fix for one check may break an earlier check. Keep looping until you get a complete clean pass — every check green on the first try with nothing fixed during that pass.

**Do NOT stop after one loop. Keep going until a full pass is clean.**

If stuck on the same failure after 5 attempts, ask the user for help.

## Step 4 — Report

- List every step that was run and its result (pass/fail/fixed).
- If any step could not be fixed, report what failed and why.
- Confirm whether the branch is ready to push.

## Step 5 — Commit/Push (only when `--failing`)

Once all CI steps pass locally:

1. Commit, but DO NOT MARK THE COMMIT WITH YOU AS AN AUTHOR!!! Only the user authors the commit!
2. Push
3. Monitor until completion or failure
4. Upon failure, go back to Step 1

## Rules

- **Always read the CI workflow first.** Never assume what commands CI runs.
- Do not push if any step fails (unless `--failing` and all steps now pass)
- Fix issues found in each step before moving to the next
- Never skip steps or suppress errors
- If the CI workflow has multiple jobs, run all of them (respecting dependency order)
- Skip steps that are CI-infrastructure-only (checkout, setup-node/rust actions, cache steps, artifact uploads) — focus on the actual build/test/lint commands
- Always coordinate with other agents via TMC

## Success criteria

- Every command that CI runs has been executed locally and passed
- All fixes are applied to the working tree
- The CI passes successfully (if you are correcting an existing failure)
