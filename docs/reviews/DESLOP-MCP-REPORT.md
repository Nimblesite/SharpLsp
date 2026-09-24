# Deslop MCP — usefulness report from a SharpLsp dedup session

**Date:** 2026-09-24 · **Repo:** SharpLsp (Rust + C# + F# + TypeScript, ~151K analysed LOC) · **Engine:** deslop MCP live index (`tool_version 0.0.0-dev`)

## Verdict

**Good at finding duplication and excellent at fast feedback. Weak at helping fix it. Misleading as a target metric on a test-heavy TypeScript repo.** Overall **6.5/10**, up from 6: across two passes the live index guided a 3.95-point reduction without a single rescan.

The live index is solid, and `find-similar` and `compare-pair` earned their keep. But the headline percentage is dominated by literal-normalised test data that nobody should "deduplicate". Overlapping clusters inflate the ranking. There's no `kind` filter or source text, so every finding costs extra round trips. `merge-plan` doesn't support TypeScript, which makes up most of this repo.

## What the session did

| | Start | After pass 1 | After pass 2 | After pass 3 |
|---|---|---|---|---|
| Duplicated LOC (MCP) | 28,417 | 27,644 | 21,791 | **20,848** |
| Analysed LOC (MCP) | ≈151,150 | 150,507 | 146,752 | 146,459 |
| Duplication % (MCP) | 18.80% | 18.37% | 14.85% (14.87% without the out-of-root file, #561) | **14.23%** |
| Identical (Type-1) clusters | n/a | n/a | 53 | **0** |
| Target asked for | 15% | not reached | reached | every identical clone gone |

Pass 1 was hand refactoring of shipped code. Pass 2 was mostly AST codemods over the VS Code test suite, plus a second round of shipped-code consolidation. The result was verified end to end:

- the full Rust suite, 682/682, with its coverage gate at 95.09%;
- all 13 VS Code shards;
- the VS Code coverage gate at 97.65%, which ratcheted its threshold up;
- the C# sidecar tests, 541/541;
- typecheck, lint and format for every language.

**Pass 1:**

- **C# sidecar:** 20+ request handlers moved onto one `HandleRequestAsync<TRequest,TValue>`; 9 of them fitted an existing `HandlePositionRequestAsync` they had never adopted. `CallHierarchyItem` and `TypeHierarchyItem` merged into `HierarchyItem`, with the same bytes on the wire.
- **F# sidecar:** 19 handlers moved onto a generic `Helpers.handle`/`atPosition`/`listOf`/`optionOf`; `FSharpSidecar.fs` went from 487 to 299 lines.
- **Rust:** call- and type-hierarchy handlers moved onto a shared `prepare_hierarchy`, and duplicate `SidecarPositionReq` structs were deleted.
- **VS Code:** suite lifecycle helpers, a shared `escapeHtml`, and a DAP `RouterChannel` base interface.

**Pass 2:**

- **Shipped code:**
  - C#: eleven `WorkspaceManager` queries moved onto the existing `RunDocumentQueryAsync`.
  - Rust: `with_sidecar`, a request-type-generic `request_sidecar`, `cached_at_position` and `or_fallback` replace hand-rolled guard, cache and fallback code in 12 handlers. The private `SidecarFileReq` copies in `code_lens.rs` and `semantic_tokens.rs` were deleted, and the profiler's two `dumpobj` parsers now share one reader.
  - `nuget.ts`: two near-identical add-package flows merged into one.
- **Test suite, by codemod** (TypeScript compiler API, AST-matched):
  - `assert.strictEqual(E, true|false, m)` became `assert.ok` at 1,533 sites. The checker confirmed `E: boolean` at each one, so no assertion changed meaning.
  - Runs of containment asserts became `assertContainsAll`/`assertContainsNone`, which report every miss at once.
  - Provider polls became `pollProvider`/`pollSymbols`.
  - Symbol walks became `childNamed`.
  - Debug preambles became `runToFirstStop`/`firstBreakpointStop`.
  - Test Explorer lifecycles became `activateWithScratch`, `teardownFixtureSolution` and `useWarmFixture`.
  - Refactor suites moved onto `useRefactorFixture`.
- **Test suite, by hand:**
  - context-menus and several parity pairs (run/debug, C#/F#) became table-driven or parameterised.
  - Case tables gained row builders and `*_SITE` constants for fields repeated on every row.
  - Multi-line fixture sources were hoisted out of test bodies.

## Tool by tool

| Tool | Rating | Notes |
|---|---|---|
| **Incremental index** | ★★★★★ | Every Write/Edit, codemod, `git checkout` and new file showed up in the next query with the generation advancing. No rescan needed, ever. |
| `duplicates` | ★★★☆☆ | The core feed. `per_file` + `folders` produced the most useful insight of the session (see below). Held back by no `kind` filter, oversized responses, silent truncation (**#562**) and overlapping clusters. |
| `cluster-by-id` | ★★★★☆ | Exact byte ranges made precise edits easy, and 8-char id prefixes resolve. No source text, so every cluster needs a separate file read. |
| `find-similar` | ★★★★☆ | Caught all 4 copies of a recursive tree search, including one renamed `searchTreeNodes`, and `existing: []` confirmed no helper existed. It missed the harder question (below). |
| `compare-pair` | ★★★★☆ | Its evidence is genuinely explanatory: `literal_fraction`, `rename_consistency` and `text_identity` showed *why* a data table was flagged. |
| `merge-plan` | ★☆☆☆☆ | "typescript consolidation is not mechanical yet (v1 covers Rust sibling modules)". Useless where most of the duplication is. |
| `rescan` | ☆☆☆☆☆ | Redundant with the incremental index, and its delta reported 0 added/removed/updated for edits that removed clusters (**#563**). |
| `session` | ★★★☆☆ | Fine. `root` is correct, which makes the out-of-root indexing (**#561**) more surprising. |
| `schema-doc` | ★★★☆☆ | Concise and accurate. Its links (`taxonomy.md`, `admission.md`) are relative paths an MCP client can't open. |

## The finding that mattered most

`include_per_file` + `folders`, grouped by area:

| Area | Dup LOC | Analysed | % |
|---|---|---|---|
| VS Code test suite | 21,415 | 79,516 | **26.9%** |
| C#/F# sidecars | 2,853 | 19,678 | 14.5% |
| Rust server | 2,019 | 20,367 | 9.9% |
| VS Code extension source | 1,203 | 25,513 | 4.7% |

Shipped code sits around **9%**; **77%** of measured duplication is in one test suite. After pass 2 the VS Code test suite is at **21.2%** (16,118 / 76,011) and everything else is at **8.0%** (5,673 / 70,541). The tool never says this. It took client-side jq over `per_file`. **A per-area / per-glob breakdown should be a first-class view.**

## Bugs filed

- **#561:** the live index counts a file **outside the workspace root** (a `/private/tmp/…/codemod.cjs` the editor had open) in `files_analysed`, `analysed_loc` and `per_file`. Every other `per_file` path is repo-relative; this one is absolute. It made a real refactor look like it *added* 91 analysed lines.
- **#562:** `duplicates` with `detail: "full", limit: 400` returned **2** clusters (`page.returned: 2`, `total_clusters: 2119`) with no truncation flag, cursor or `next_action`. The `summary` path does say "use a smaller limit".
- **#563:** `rescan` is redundant; its `summary` reported zero changes for edits that removed clusters, and its `cache_stats` read `hits: 485, misses: 0` straight after 6 files changed.
- **#562 recurred in pass 2:** `detail: "full", limit: 40` with `path` set returned 2 of 72 clusters, with no truncation signal.
- **#561 is still live:** the out-of-root scratch file still counts toward `analysed_loc`, so the headline percentage is about 0.02 points kinder than the workspace-only figure.
- **#564 (pass 3):** the MCP cannot request the editor's "Identical code" bucket.
  - There is no `kind` filter, and Type-1 clusters carry `severity: "warning"` like Type-3, so `severities: ["error"]` returns nothing.
  - Finding the 53 identical clusters took three oversized `duplicates` pages that spilled to disk, filtered with `jq`.
  - The editor showed **43** for the same bucket.

### Pass 3: every identical clone

Pass 3 took all 53 `identical` clusters to zero, working cluster by cluster with `cluster-by-id` for the byte ranges and the live index to confirm each one disappeared.

- **Test suites:** shared kits replaced local copies. Examples:
  - `useRefactorFixture` now returns getters, so six suites lost their `let` / `setup` prologue.
  - New `withRouter`, `LiveRouter.stopped` and `topStack` helpers for the debug router.
  - `useUiStubs` and `useRenameFixtures`.
  - One `tree-node-kit.ts`, where five files had their own label/finder helpers.
  - One `document-anchors.ts` for three copies of `diagnosticCode` and the position helpers.
- **Shipped code:**
  - C#: `CallHierarchyCallResult` now derives from `HierarchyItem`, with the same MessagePack keys.
  - C#: the symbol-at-position walk is shared between the definition and call-hierarchy resolvers, and `SpansTouch`, `TypeHint` and the rewrite-diagnostic IDs each exist once.
  - Rust: `grow_backoff`, `field_tokens` and `modified_target`.
  - TypeScript: `pickDump`/`diffAgainst` in the heap diff, `activeFSharpEditor`, and one sort-policy default.
- **What helped:** the incremental index again. Every edit showed up in the next `cluster-by-id` as "no cluster with id …", which made progress checkable per cluster.
- **Verified end to end:**
  - the Rust suite, 682/682, with coverage at 95.12%;
  - all 13 VS Code shards, with every pass count unchanged;
  - the VS Code coverage gate at 97.67%, which ratcheted its threshold from 96.65 to 96.67;
  - the .NET suites: Common 92, C# 541 and F# 409;
  - typecheck, lint and format for every language.
- **Side effects:**
  - Removing the Type-1 copies also dissolved some Type-2/3 clusters.
  - A few extractions surfaced semantic duplicates the tool had not clustered: `fullDocumentRange` ×2, `LspRange` ×4, and `diagnosticCode` ×3 with different bodies. None of these can be found with a kind filter; they need `find-similar`.

## Why the percentage resists honest reduction

1. **Literal-normalised Type-2 matching counts test *data* as duplicate *code*.**
   - A 30-row rename case table (`{label, snippet, oldName, newName, editCount}` objects): `compare-pair` measured `literal_fraction: 0.43`, `structural: 1.0`, `fused: 1.0`, and **admitted** it as `nearly_identical`. The signal exists and is measured, but it doesn't gate admission or discount mass.
   - Tests with different inline C# fixture sources collapse to one "13-line × 15" clone, because the template literal is normalised away.
   - Two-line `assert.ok(labels.has('X'), 'msg')` pairs form **61-copy** clusters, ranked #2, #3, #5 and #6 by mass. Wrapping them in a helper would hide the per-assertion messages.
2. **Overlapping clusters inflate the ranking.** One 8-line region (`debug-callstack-e2e.test.ts:47-54`) is reported as **7 separate clusters** at different granularities (`0a484efc`, `a5637811`, `589f9985`, `6a13b1b7`, `3b5be30a`, `3a21e850`, `0d4f0d44`) and fills most of the top 10.
3. **Consolidating logic can make the number worse.** I moved a 4-statement debug preamble repeated 48 times into a helper. Prettier reflows each call to 6 lines because the per-site messages are long, and the 48 call sites become a *new* Type-2 family. Result: **+44 duplicated LOC, +133 analysed LOC**, so I reverted it. The metric penalises centralising logic whenever call sites carry long literals.
4. **The MCP and CI numbers disagree.** The live engine said **18.80%**; the pinned CLI 0.34.0 that CI enforces said **15.01%** on the same tree. `.deslop.toml` already documents this gap, but a user looking at the extension panel is optimising a number the gate doesn't use.

### What actually moved the number in pass 2

1. **Line-shrinking codemods beat clever helpers.** The single biggest drop came from `strictEqual(E, true)` → `ok(E)` (−737 duplicated LOC). The structural similarity was untouched; prettier just fit most asserts on fewer lines. The metric is line-weighted, so formatting-level simplification counts as much as real consolidation.
2. **Hoisting fixture literals out of similar prologues.** A 3-statement prologue wrapped around a 20-line template literal is a 23-line clone. Moving the literal to a named module constant shrank those clones to 3–4 lines without changing a single assertion. This confirms the finding from pass 1: literal spans inside a clone are counted in full.
3. **Helpers can make it worse, and the index shows it within seconds.** Twice a helper introduced a new cluster at exactly the 30-node threshold: a 6-line `firstBreakpointStop(recorder, SOURCE, anchor, why)` call ×14, and an `openCSharpOutline` prologue ×20. Both times the next query showed it immediately. The fixes were a one-line call signature and hoisting the fixtures. **Fast feedback is the best thing about the live index.**
4. **Row builders for case tables.** Default-able fields (`kind: 'quickfix'`, `caretOnly: true`, `fixture: 'symbols'`) and derivable fields (`key`, `projectName`, `projectFileName` from framework × language) were the dominant repeated lines in the table-driven suites.

## What it missed

- **Small exact duplicates below `min_nodes: 30`.** `SidecarPositionReq` (a 3-field wire struct) was defined **four times** in the Rust crate (`utils.rs`, `semantic.rs`, `type_hierarchy.rs`, `formatting.rs`) and never reported. Named type definitions that are byte-identical should be reported regardless of size.
- **"Where would this helper apply?"** `find-similar` on a proposed helper body returned nothing, although the body appeared inline 48 times. The inline copies used a destructured `fixture` where the helper used `debuggee.fixture`. That's the question you most need answered before writing a helper.
- **Behavioural divergence inside a cluster.** Three HTML-escape functions were grouped because four of their `.replace` calls match, but only one escapes `'`. The cluster doesn't flag that its members *differ in behaviour*, which was the actual bug-risk. (Here a test pins the profiler's behaviour, so it was left as is, documented, and consolidated to one copy.)

## Friction

- **No `kind` filter.** `identical` and `nearly_identical` both map to `severity: warning`, and `severities: ["error"]` returns nothing. Finding the 61 identical clusters took paging all 2,136 and filtering client-side.
- **Response size.** A 250-cluster `summary` page is ~78 KB and a 700-cluster page ~205 KB, both past client limits and spilled to disk. There's no field projection.
- **`path_contains` matches any occurrence**, but the summary shows only `first_occurrence`, which is often in a different file. That's confusing without saying which occurrence matched.
- **No removable-lines estimate.** Ranking by mass doesn't say what a fix would save. I computed `span × (copies − 1)` by hand, and even that ignores formatter reflow.

## Recommendations, in priority order

1. **Discount or gate on `literal_fraction`** (and literal-heavy spans such as template literals and object-literal arrays), so test data stops dominating the score.
2. **Subsume overlapping clusters**, one region → one ranked finding, with nested views on demand.
3. **Per-area breakdown** as a first-class response (by folder or glob, test vs source).
4. **Honest pagination** (#562) plus a `kinds` filter and field projection.
5. **Return a source snippet from `cluster-by-id`**, even just the canonical occurrence.
6. **Retire `rescan`** (#563), or make its delta relative to a caller-supplied generation.
7. **Fix out-of-root indexing** (#561).
8. **Report identical named type/struct definitions regardless of `min_nodes`.**
9. **Add a `find-similar` "applicability" mode** that matches a helper body against inline sequences modulo local-vs-member access.
10. **Add `merge-plan` for TypeScript.**
11. **Flag behavioural divergence** inside a cluster (for example, one member has an extra call).
12. **Converge the MCP and CLI engines**, or label every number with the engine that produced it.
