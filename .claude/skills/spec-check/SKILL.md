---
name: spec-check
description: Audits spec/plan documents against the codebase, ensuring every spec section has implementing code, tests, and matching logic. Use when the user says "check specs", "audit specs", "spec coverage", or "spec-check".
argument-hint: "[optional spec-id or file path to check]"
---
<!-- agent-pmo:3140e31 -->

# Spec Check

Audit spec and plan documents against the codebase. Every spec section must have implementing code, tests, and the logic must match.

## Step 1 — Validate Spec IDs

Scan all files in `docs/specs/` and `docs/plans/` for spec section IDs.

**Valid ID format:** `[GROUP-TOPIC]` or `[GROUP-TOPIC-DETAIL]` — uppercase, hyphen-separated, hierarchical, descriptive. NEVER numbered.

- Good: `[AUTH-LOGIN]`, `[CI-TIMEOUT]`, `[LINT-ESLINT]`, `[AUTH-TOKEN-VERIFY]`
- Bad: `[SPEC-001]`, `[REQ-003]`, `[FEAT-AUTH-01]`, `[TIMEOUT]`

For each spec file:
1. Extract all `[BRACKETED-IDS]` from headings
2. Validate format: uppercase, hyphen-separated, no trailing numbers, has a group prefix
3. Check for duplicates across all spec files
4. Report any violations

## Step 2 — Find All Specs

List every spec file in `docs/specs/` and every plan file in `docs/plans/`. Extract all spec section IDs from each.

If an argument was provided:
- If it looks like a spec ID (e.g., `[AUTH-LOGIN]`), filter to only that ID
- If it looks like a file path, filter to only that file's IDs

## Step 3 — Check Each Spec Section

For each spec section ID found:

### 3a. Find implementing code

Search the entire codebase (excluding `docs/`, `node_modules/`, `target/`, `bin/`, `obj/`) for references to the spec ID in comments:

```
// Implements [SPEC-ID]
# Implements [SPEC-ID]
-- Implements [SPEC-ID]
/* Implements [SPEC-ID] */
/// Implements [SPEC-ID]
```

Also check for partial references:
```
// [SPEC-ID]
# [SPEC-ID]
```

Record which files and lines reference each spec ID.

### 3b. Find tests

Search test files (files matching `*test*`, `*spec*`, `*_test.*`, `test_*.*`) for references to the spec ID:

```
// Tests [SPEC-ID]
# Tests [SPEC-ID]
```

Record which test files reference each spec ID.

### 3c. Logic matching (spot check)

For spec sections that DO have implementing code:
1. Read the spec section content
2. Read the implementing code
3. Compare: does the code actually do what the spec says?
4. Flag any obvious mismatches (spec says X, code does Y)

## Step 4 — Report

Generate a report with these sections:

### ID Validation
- List any invalid spec IDs (numbered, missing group, duplicated)

### Coverage Matrix
For each spec section:
```
[SPEC-ID] — "Section title"
  Code refs:  file1.rs:42, file2.cs:108  (or "NONE ⚠️")
  Test refs:  test_file.rs:55            (or "NONE ⚠️")
  Logic match: ✓ / ⚠️ mismatch / — not checked
```

### Summary
- Total spec sections: N
- With code references: N (%)
- With test references: N (%)
- Logic mismatches found: N
- Invalid IDs found: N

### Action Items
List specific things to fix, ordered by priority:
1. Invalid spec IDs that need renaming
2. Spec sections with NO implementing code
3. Spec sections with NO test references
4. Logic mismatches

## Rules

- NEVER modify spec files during this audit — report only
- NEVER modify code files during this audit — report only
- If a spec section is aspirational (describes future work), note it but don't flag it as missing
- Check ALL comment styles for the repo's languages (Rust `//`/`///`, C# `//`/`///`, TypeScript `//`, F# `//`)
- Spec IDs are case-sensitive — `[auth-login]` does NOT match `[AUTH-LOGIN]`
