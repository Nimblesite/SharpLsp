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

- [ ] Cold start < 3 seconds to first LSP response
- [ ] Warm completion latency < 100ms p50, < 200ms p95
- [ ] Hover latency < 150ms p50
- [ ] Find references (1000-file solution) < 2 seconds

## Memory Targets

- [ ] Memory < 2GB Rust + < 3GB sidecar (600K LOC solution)

## Hover Benchmarks

- [ ] Benchmark hover latency on cold start (first hover after project load)
- [ ] Benchmark hover latency on warm cache (repeated hover on same position)
- [ ] Benchmark hover latency on large solution (~2M LOC)
- [ ] Validate tree-sitter pre-validation rejects non-symbol positions in <1ms
- [ ] Profile sidecar memory usage during sustained hover requests
