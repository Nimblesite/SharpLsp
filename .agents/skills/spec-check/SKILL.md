---
name: spec-check
description: Audit spec/plan documents against the codebase. Ensures every spec section has implementing code, tests, and matching logic. Use when the user says "check specs", "spec audit", or "verify specs".
argument-hint: "[optional spec ID or filename filter]"
---
<!-- agent-pmo:2efd847 -->

# spec-check

Audit spec/plan documents against the codebase. Ensures every spec section has implementing code, tests, and that the code logic matches the spec.

## Arguments

- `$ARGUMENTS` — optional spec name or ID to check (e.g., `AUTH-TOKEN-VERIFY` or `diagnostics`). If empty, check ALL specs. Spec IDs are descriptive slugs, NEVER numbered.

## Instructions

Follow these steps exactly. Be strict and pedantic. Stop on the first failure.

---

### Step 1: Validate spec ID structure

Before checking code/test references, verify that the specs themselves are well-formed.

1. Find all spec documents in `docs/specs/` and `docs/plans/`.
2. Extract every section ID using the regex `\[([A-Z][A-Z0-9]*(-[A-Z0-9]+)+)\]`.
3. **Flag invalid IDs:**
   - Numbered IDs (`[SPEC-001]`, `[REQ-003]`, `[CI-004]`) — must be renamed to descriptive hierarchical slugs.
   - Single-word IDs (`[TIMEOUT]`) — must have a group prefix.
   - IDs with trailing numbers (`[FEAT-AUTH-01]`) — the number is meaningless, remove it.
4. **Check group clustering:** The first word of each ID is its group. All sections in the same group MUST appear together (adjacent) in the document. If they're scattered, flag it.
5. **Check for missing IDs:** Any heading that defines a requirement or behavior should have an ID. Flag headings in spec files that look like they define behavior but lack an ID.

If any ID violations are found, report them all and **STOP**:
```
SPEC ID VIOLATIONS:

- docs/specs/EXAMPLE-SPEC.md line 12: [SPEC-001] → rename to descriptive ID (e.g., [EXAMPLE-LOGIN])
- docs/specs/EXAMPLE-SPEC.md line 30: [EXAMPLE-A] and [EXAMPLE-B] are not adjacent (scattered group)
- docs/specs/CI-SPEC.md line 5: "## Coverage thresholds" has no spec ID

Fix spec IDs first, then re-run spec-check.
```

If all IDs are valid, proceed to Step 2.

---

### Step 2: Find all spec/plan documents

Search for markdown files that contain spec sections with IDs. Look in these locations:

- `docs/specs/*.md`
- `docs/plans/*.md`
- `docs/**/*.md`

Use Glob to find candidate files, then use Grep to confirm they contain spec IDs.

**Spec ID patterns** — IDs appear in square brackets, typically at the start of a heading or section line. Match this regex pattern:

```
\[([A-Z][A-Z0-9]*(-[A-Z0-9]+)+)\]
```

For each file, extract every spec ID and its associated section title (the heading text after the ID) and the full section content (everything until the next heading of equal or higher level).

---

### Step 3: Filter specs

- If `$ARGUMENTS` is non-empty, filter the discovered specs:
  - If it matches a spec ID exactly (e.g., `AUTH-TOKEN-VERIFY`), check only that spec.
  - If it matches a partial name (e.g., `diagnostics`), check all specs in files whose path contains that string.
- If `$ARGUMENTS` is empty, process ALL discovered specs.

If filtering produces zero specs, report an error:
```
ERROR: No specs found matching "$ARGUMENTS". Discovered spec files: [list them]
```

---

### Step 4: Check each spec section

For EACH spec section that has an ID, perform checks A, B, and C below. **Stop on the first failure.**

#### Check A: Code references the spec ID

Search the entire codebase for the spec ID string, **excluding** these directories:
- `docs/`
- `node_modules/`
- `target/`
- `bin/`
- `obj/`
- `*.md` files (markdown is docs, not code)

Use Grep with the literal spec ID (e.g., `[AUTH-TOKEN-VERIFY]`) to find references in code files.

Code files should contain comments referencing the spec ID. The search must catch **all** comment styles for SharpLsp's languages:

**Rust** (`//`, `///`):
- `// Implements [SPEC-ID]`
- `/// Implements [SPEC-ID]`

**TypeScript/JavaScript** (`//`):
- `// Implements [SPEC-ID]`

**C#** (`//`, `///`):
- `// Implements [SPEC-ID]`
- `/// Implements [SPEC-ID]`

**F#** (`//`, `///`, `(* *)`):
- `// Implements [SPEC-ID]`
- `(* Implements [SPEC-ID] *)`

**The key rule:** any comment in any language containing the exact spec ID string counts as a valid code reference. Just search for the spec ID string itself.

**If NO code files reference the spec ID:**

```
SPEC VIOLATION: [SPEC-ID] "Section Title" has no implementing code.

Every spec section must have at least one code file that references it via a comment
containing the spec ID (e.g., `// Implements [SPEC-ID]`).

ACTION REQUIRED: Add a comment referencing [SPEC-ID] in the file(s) that implement
this spec section, then re-run spec-check.
```

**STOP HERE. Do not continue to other checks.**

#### Check B: Tests reference the spec ID

Search test files for the spec ID. Test files are found in:
- `tests/`
- `**/*.test.*`
- `**/*.spec.*`
- `**/*_test.*`
- `**/test_*.*`
- `**/*Tests.*`

Use Grep to search these locations for the literal spec ID string.

Tests should contain the spec ID in comments, test names, or annotations:

**Rust:**
- `// Tests [SPEC-ID]`
- `#[test] // Tests [SPEC-ID]`

**TypeScript** (Jest/Mocha/Vitest):
- `// Tests [SPEC-ID]`
- `describe('[SPEC-ID] description', () => ...)`
- `test('[SPEC-ID] should ...', () => ...)`

**C#** (xUnit):
- `// Tests [SPEC-ID]`
- `[Fact] // Tests [SPEC-ID]`

**F#** (xUnit/Expecto):
- `// Tests [SPEC-ID]`
- `[<Fact>] // Tests [SPEC-ID]`

**If NO test files reference the spec ID:**

```
SPEC VIOLATION: [SPEC-ID] "Section Title" has no tests.

Every spec section must have corresponding tests that reference the spec ID.

ACTION REQUIRED: Add tests for [SPEC-ID] with a comment or test name containing
the spec ID, then re-run spec-check.
```

**STOP HERE. Do not continue to other checks.**

#### Check C: Code logic matches the spec

This is the most critical check. You must:

1. **Read the spec section content carefully.** Understand exactly what behavior, logic, ordering, conditions, and constraints the spec describes.

2. **Read the implementing code.** Use the references found in Check A to locate the implementing files. Read the relevant functions/sections.

3. **Compare spec vs. code.** Be SENSITIVE and PEDANTIC. Check for:
   - **Ordering violations** — If the spec says A happens before B, the code must do A before B.
   - **Missing conditions** — If the spec says "only when X", the code must have that condition.
   - **Extra behavior** — If the code does something the spec doesn't mention, flag it only if it contradicts the spec.
   - **Wrong logic** — If the spec says "greater than" but code uses "greater than or equal", that's a violation.
   - **Missing steps** — If the spec describes 5 steps but code only implements 3, that's a violation.
   - **Wrong defaults** — If the spec says "default to X" but code defaults to Y, that's a violation.

4. **If the code deviates from the spec**, report a detailed error:

```
SPEC VIOLATION: [SPEC-ID] Code does not match spec.

SPEC SAYS:
> "quoted spec text"
> (from docs/specs/EXAMPLE-SPEC.md, line 42)

CODE DOES:
> `actual code` (src/example.rs:42)

DEVIATION: Description of what's different.

ACTION REQUIRED: What to change and where.
```

**STOP HERE. Do not continue to other specs.**

5. **If the code matches the spec**, this check passes. Move to the next spec.

---

### Step 5: Report results

#### On failure (any check fails):

Output ONLY the first violation found. Use the exact error format shown above. Do not summarize other specs. Do not offer to fix the code. Just report the violation.

End with:
```
spec-check FAILED. Fix the violation above and re-run.
```

#### On success (all specs pass):

Output a summary table:

```
spec-check PASSED. All specs verified.

| Spec ID | Title | Code References | Test References | Logic Match |
|---------|-------|-----------------|-----------------|-------------|
| [SPEC-ID] | Section Title | src/file.rs | tests/file.rs | PASS |
| ... | ... | ... | ... | ... |

Checked N spec sections across M files. All have implementing code, tests, and matching logic.
```

---

## Rules

- **NEVER modify spec files during this audit** — report only
- **NEVER modify code files during this audit** — report only
- **NEVER modify test files during this audit** — report only
- **Fail fast.** Stop on the first violation. One fix at a time.
- **Be pedantic.** If the spec says it, the code must do it. No "close enough".
- **Quote everything.** Always quote the spec text and the code in error messages so the developer sees exactly what's wrong.
- **Be actionable.** Every error must tell the developer what file to change and what to do.
- **Exclude docs from code search.** Markdown files are documentation, not implementation.
- **No numbered IDs.** Spec IDs are hierarchical descriptive slugs, NEVER sequential numbers.
- If a spec section is aspirational (describes future work), note it but don't flag it as missing.
- Spec IDs are case-sensitive — `[auth-login]` does NOT match `[AUTH-LOGIN]`.
