---
name: regression-review
description: Aggressive adversarial review of the current branch against the last release, hunting regressions. Logs every confirmed bug as a GitHub issue. Use when the user says "adversarial review", "regression review", "review against the release", or before cutting a release.
---

# Regression Review

Find what this branch breaks that the last release got right. You own every verdict.

## Scope

- Last release: `gh release view --json tagName -q .tagName` (fall back to `git describe --tags --abbrev=0`)
- Diff: `git fetch --tags && git diff <tag>...HEAD --stat`, then read every changed file in full — not just hunks
- Rank areas by blast radius: discovery/loading, request routing, IPC, edits applied to user files, config, editor wiring

## Hunt

- Read old and new behaviour side by side (`git show <tag>:<path>`); every removed branch, guard, fallback or default is a suspect
- Trace each change to its callers: blocking calls on the main loop, missing timeouts, unbounded parallelism, caches never invalidated
- Attack edges: empty/missing config, nested or competing solutions, unsaved buffers, CPM/props, transitive packages, Windows paths, F# and C# both
- Check the change is wired end to end: server capability, editor registration, command routing
- Tests that re-implement the code they test, or assert less than their name claims, are findings

## Legwork

- Up to two `pi` sessions may each take one bounded slice (a file set + concrete questions); give them the diff range and these rules
- Kill a pi that stalls; never wait on it
- Treat pi output as leads, not findings: open the code and confirm every claim yourself before it counts
- Never use sub-agents

## Tests

- This is a review, not CI prep: **never run the whole CI suite** (no `make test`, `make ci`, full e2e shards or VS Code suites) and never trigger GitHub Actions
- Run a single targeted test only to confirm a specific suspected bug (e.g. `cargo test --test <file> <name>`), or to prove one with a new failing test

## Verdict

- Confirmed = you traced the mechanism in code and can state input → wrong output; prove it with a failing test when cheap
- Drop anything you could not confirm; say so rather than pad the list
- Regression vs the release, or a new bug on the branch — label which

## Report

- Bug present in the released tag → `gh issue create --label bug` per bug: title, release tag, file:line, repro, expected vs actual; search `gh issue list --search` first to avoid duplicates
- Branch-only bug → hand it to the branch owner (message or failing test), no issue
- Reply with confirmed findings, severity first, and exactly what you did and did not review
