# Performance Plan

Performance targets and benchmarking.

## Optimization

- [ ] Performance optimization pass (memory budgets, cache eviction, lazy loading)

## Progressive Solution Load [PERF-PROGRESSIVE-LOAD]

GitHub #563. Opening a solution currently blocks until every project is restored and
evaluated (30-110 s for TestFixtures.sln from the repo folder), and the Solution
Explorer shows one spinner until all of it ends ([SE-LOADING-FEEDBACK]). A load MUST be
progressive: each project appears and becomes usable the moment it is loaded, and the
user never waits on projects they are not looking at.

- [ ] F# sidecar opens the selected or configured solution first and never the
      recursive folder glob while a solution is selected (today it restores and loads
      all 33 `.fsproj` under the repo before TestFixtures.sln)
- [ ] Restore skips projects whose restore succeeded and whose inputs are unchanged
      (`WorkspaceRestore.AssetsCurrent` is stale on every open: 203 restores of one
      project in a day)
- [ ] Restore and evaluate projects concurrently (bounded), not one after another
- [ ] Order the load: the project owning the active editor first, then its
      references, then the rest of the solution
- [ ] Sidecars stream per-project progress to the host (`$/progress`-style
      notification: project loaded, failed, restoring), and the host forwards it
- [ ] Solution Explorer adds each project node as its load completes. A project
      still loading shows its own spinner; the tree never sits behind one solution-wide
      spinner. Update [SE-LOADING-FEEDBACK] in SOLUTION-EXPLORER-SPEC.md first
- [ ] Features (hover, definition, diagnostics) answer for a loaded project while
      other projects are still loading; a request for a not-yet-loaded project says so
      instead of hanging
- [ ] One F# open per session, not 2-3 consecutive reopens
- [ ] E2E test: open TestFixtures.sln from a folder containing other `.fsproj` files.
      Assert that the first project node and the first hover arrive before the last
      project loads, that nothing outside the solution is restored, and that a second
      open restores nothing

## Latency Targets

- [x] Cold start < 3 seconds to first LSP response — `performance_budgets.rs` `hover_completion_and_memory_meet_their_budgets`: 1.4s to the `initialize` response, 1.5s to the first syntax answer (debug host)
- [x] Warm completion latency < 100ms p50, < 200ms p95 — same test: p50 3ms / p95 20ms on 1000 files, 21ms / 43ms on 600K lines, 26ms / 67ms on 2M lines
- [x] Hover latency < 150ms p50 — same test: p50 2.2ms / p95 2.8ms on 1000 files
- [x] Find references (1000-file solution) < 2 seconds — `navigation_latency.rs` `navigation_meets_its_latency_and_memory_budgets_on_a_thousand_files`: 1002 references in 184ms

## Memory Targets

- [x] Memory < 2GB Rust + < 3GB sidecar (600K LOC solution) — same test with `SHARPLSP_BENCH_FILES=1200 SHARPLSP_BENCH_LINES=500`: host 37MB, C# compiler 1080MB; on 2M lines 42MB and 2892MB against the 3GB / 5GB row (2026-11-16, macOS arm64)

## Hover Benchmarks

- [x] Benchmark hover latency on cold start (first hover after project load) — same test: 12ms on 1000 files, 31ms on 600K lines, 114ms on 2M lines
- [x] Benchmark hover latency on warm cache (repeated hover on same position) — same test: 1.4ms round trip; the memo hit itself is under 1ms (`semantic_memo_tests.rs`)
- [x] Benchmark hover latency on large solution (~2M LOC) — same test with `SHARPLSP_BENCH_FILES=4000 SHARPLSP_BENCH_LINES=500`: p50 4.8ms / p95 9.9ms
- [x] Validate tree-sitter pre-validation rejects non-symbol positions in <1ms — `handlers_tests.rs`, shared with [DEFINITION-PERFORMANCE]
- [x] Profile sidecar memory usage during sustained hover requests — same test: 400 un-memoized hovers across ten edits move the compiler 238MB → 257MB (2791MB → 2892MB on 2M lines), asserted under 200MB growth
