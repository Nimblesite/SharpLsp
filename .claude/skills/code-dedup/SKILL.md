---
name: code-dedup
description: Searches for duplicate code, duplicate tests, and dead code across the Forge repo, then safely merges or removes them. Use when the user says "deduplicate", "find duplicates", "remove dead code", "DRY up", or "code dedup". Requires test coverage — refuses to touch untested code.
---

# Code Dedup

Carefully search for duplicate code, duplicate tests, and dead code across the repo. Merge duplicates and delete dead code — but only when test coverage proves the change is safe.

## Prerequisites — hard gate

Before touching ANY code, verify these conditions. If any fail, stop and report why.

1. Run `make test` — all tests must pass. If tests fail, stop.
2. Verify static typing is in place (Rust, TypeScript strict, C#/F# — all typed by default).

## Steps

### Step 1 — Inventory test coverage

1. Run `make test` and confirm green baseline
2. Note coverage percentages per project (see `coverage-thresholds.json`) — this is the floor
3. Only files WITH coverage are candidates for dedup

### Step 2 — Scan for dead code

1. Rust: check `cargo clippy` output for dead code warnings
2. TypeScript: look for unused exports/functions with zero references
3. C#/F#: analyzer warnings for unused members
4. For each candidate: grep the entire codebase. Only mark as dead if truly zero references.

### Step 3 — Scan for duplicate code

1. Look for functions/methods with identical or near-identical logic
2. Check across module boundaries (Rust crates, .NET projects, TS modules)
3. List all duplicates found. Do NOT merge yet.

### Step 4 — Scan for duplicate tests

1. Look for test functions with identical assertions
2. Look for duplicated test fixtures/helpers
3. List all duplicate tests found. Do NOT delete yet.

### Step 5 — Apply changes (one at a time)

For each change: **change -> test -> verify coverage -> continue or revert**.

- After each change: run `make test` and check coverage
- If tests fail or coverage drops: **revert immediately**

### Step 6 — Final verification

1. Run `make test` — all tests must still pass
2. Coverage must be >= baseline from Step 1
3. Run `make lint` and `make fmt-check` — code must be clean

## Rules

- **No test coverage = do not touch.**
- **Coverage must not drop.** The floor from Step 1 is sacred.
- **One change at a time.** Never batch multiple dedup changes before testing.
- **When in doubt, leave it.** False dedup is worse than duplication.
- **Three similar lines is fine.** Only dedup when shared logic is substantial (>10 lines) or 3+ copies.
