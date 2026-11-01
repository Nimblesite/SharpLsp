# Static Regression Review — `ab8e713d` → `origin/chore/test-host-no-ai-actions`

**Reviewed tree:** `e4e7963398088a8ee7726c675b24a2da2f762c38` (the branch tip at completion of review)  
**Base:** `ab8e713d0597843bf2fbc3151701a38e4aba9989`  
**Scope:** 979 changed files; static review only. No build, test execution, repository mutation, commit, or push was performed.

## Findings

### R-01 — Contributor film still archives the deleted lspkit submodule

- **Severity:** Medium
- **Location:** `src/website/tools/video/kit/set.mjs:72` (called from `src/website/tools/video/films/contributing/film.mjs:65` through `REPO`)
- **Evidence:** `REPO.stage` still executes `unpackHead(path.join(repoRoot, 'lspkit'), ...)`, and `unpackHead` runs `git -C <repo>/lspkit archive HEAD` at lines 51–54. This diff deletes both `.gitmodules` and the `lspkit` gitlink; the replacement source lives under `target/lspkit-0.4.0`, not `lspkit/`.
- **Why this is a regression:** Every `contributing` shoot reaches this staging function before VS Code starts. `git archive` now runs in a nonexistent directory and the non-zero status is thrown at line 54, so a film that previously staged the two repositories can no longer be recorded. The second archive should be removed or deliberately migrated to the fetched source; leaving the old path guarantees failure.

### R-02 — The new MoveType demo violates the Shop set's one-solution invariant

- **Severity:** Medium
- **Location:** `src/website/tools/video/kit/set.mjs:26`, with the recursive copy at `src/website/tools/video/kit/set.mjs:92-95`
- **Evidence:** `SHOP` promises that the staged workspace holds exactly one solution and omits `Storefront.slnx`, `FsStorefront.slnx`, `blazor-storefront`, and `csharp14`. The new `MOVETYPE` set is declared at line 48, and `src/website/tools/video/demos/movetype/MoveType.slnx` is added by this diff, but `movetype` is absent from `SHOP.omit`. `stageDemo` recursively copies the entire demo root and filters only the names in that list.
- **Why this is a regression:** Every film using `SHOP` now stages both the root `Shop.slnx` and nested `movetype/MoveType.slnx`, contradicting the set's explicit single-solution contract. Solution auto-discovery in the filmed SharpLsp workspace can become ambiguous or select the MoveType solution instead of the C#+F# Shop solution. Adding one demo has therefore changed the behavior of pre-existing language films.

### R-03 — A failed lspkit extraction can be cached as a successful fetch

- **Severity:** Low
- **Location:** `Makefile:271-276`
- **Evidence:** The directory `$(LSPKIT_DIR)` is itself the Make target and its only completion marker. The recipe streams `curl ... | tar -xz -C target` directly into the parent of that directory. Extraction creates `target/lspkit-0.4.0` before the archive has been fully read; no temporary directory, completion sentinel, or cleanup follows a failed pipeline.
- **Why this is a regression:** If the download is truncated or `tar` fails after creating the directory, the first invocation fails but leaves the target present. Every later `make _fetch-lspkit` then considers it up to date and skips extraction, so `_build-dotnet`, profiler fixture consumers, audits, and spec-citation checks reuse a partial tree until the user manually deletes it. The submodule checkout did not treat the mere presence of this directory as a completed source fetch. Extract to a temporary directory and rename only after success.

## Regression Checks That Did Not Produce Findings

- **Tests and assertions:** No test file was deleted. Removed helper assertions were found in their extracted helpers (`run-task-recorder.ts`, `RefactoringProject.cs`, `TextEditing.cs`, and the Rust test-module splits). The profiler webview suite now imports the published package's shared contract, which contains the replacement hardening, results, panel, and palette suites rather than merely deleting those checks.
- **VS Code suite ownership:** All 208 target `.test.ts` suites map to exactly one `test-chunks.json` entry; every chunk pattern is non-empty. The `profiler*.test.js` and `memory-*.test.js` patterns include all profiler and memory e2e suites.
- **Rust and F# test discovery:** Every added top-level and nested Rust e2e module is declared. Every Rust `#[path]` resolves to a tracked file. All F# source and test files occur exactly once in their project files.
- **Async migrations:** New profiler decoration and cleanup promises are awaited at their call sites; F# `Task`-returning workspace, compile-order, and code-action calls are awaited or explicitly synchronised in existing test fixtures. No newly unawaited migration call was found.
- **Paths and references:** All local GitHub composite-action references and reviewed relative TypeScript/JavaScript imports resolve. `LSPKIT_DIR` is exported for profiler fixtures and fetched before the .NET build, .NET audit, VS Code shards, and spec-citation gate. No stale `_build-profiler-ui` or `tools/profiler-film` invocation remains.
- **Dependencies:** No Cargo or npm dependency downgrade was found relative to the base. The lspkit crates and UI move from local `0.0.1` packages to published `0.4.0` packages; other changed versions are upgrades or added transitive versions.
- **Specs and merges:** No dangling spec-ID citation was found, including against lspkit's profiler and pull specs. Removed spec headings are not still cited. No conflict markers or lost test-module hunks were found; the audit prerequisite added during the branch's final commit is present.
- **CI execution:** New tooling tests are invoked by their declared legs, VS Code matrix generation consumes the updated chunk manifest, and coverage/duplication thresholds were not weakened.

## Limitations

This was a static review, as requested. Behavioral conclusions above follow from direct control flow and path resolution, not from executing the affected films or build targets.
