---
name: fix-ci
description: Fetches the latest GitHub Actions logs for the current branch's PR, analyzes all failures, and fixes them. Use when CI is red, a PR has failing checks, or the user says "fix ci". Requires an open PR for the current branch.
argument-hint: "[optional job name to focus on]"
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---

# Fix CI

Diagnose and fix all GitHub Actions failures for the current branch's PR.

## Step 1: Validate branch has a PR

```bash
BRANCH=$(git branch --show-current)
PR_JSON=$(gh pr list --head "$BRANCH" --state open --json number,title,url --limit 1)
```

If the JSON array is empty, **stop immediately**:
> No open PR found for branch `$BRANCH`. Create a PR first.

Otherwise extract the PR number and continue.

## Step 2: Fetch failed logs

```bash
PR_NUMBER=$(echo "$PR_JSON" | jq -r '.[0].number')
gh pr checks "$PR_NUMBER"
RUN_ID=$(gh run list --branch "$BRANCH" --limit 1 --json databaseId --jq '.[0].databaseId')
gh run view "$RUN_ID"
gh run view "$RUN_ID" --log-failed
```

Read **every line** of `--log-failed` output. For each failure note the exact file, line, and error message.

If `$ARGUMENTS` specifies a job name, prioritize that job but still report all failures.

## Step 3: Categorize and fix

Work through failures in this order:

1. **Formatting** — run auto-formatters first to clear noise
2. **Compilation errors** — must compile before lint/test
3. **Lint violations** — fix the code pattern
4. **Runtime / test failures** — fix source code to satisfy the test

### Hard constraints

- **NEVER modify test files** — fix the source code, not the tests
- **NEVER add suppressions** (`#[allow(...)]`, `// eslint-disable`, `#pragma warning disable`)
- **NEVER use `any` in TypeScript** to silence type errors
- **NEVER delete or ignore failing tests**
- **NEVER remove assertions**

## Step 4: Loop `make ci` until green

```bash
make ci
```

If it fails: read output, fix the issue (same constraints as Step 3), run again. **Keep looping until a full pass is clean.**

If stuck on the same failure after 5 attempts, ask the user for help.

## Step 5: Report

Once `make ci` passes:

1. List each CI issue found and what was fixed
2. Confirm `make ci` passes locally
3. Suggest pushing to verify remote CI
