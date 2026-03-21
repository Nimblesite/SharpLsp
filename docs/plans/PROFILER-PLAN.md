# Profiler Integration Implementation Plan

**Spec:** [PROFILER-SPEC.md](../specs/PROFILER-SPEC.md)

## Context

Forge wraps the standard .NET diagnostic CLI tools (`dotnet-trace`, `dotnet-counters`, `dotnet-dump`) with a clean editor UI. All profiler logic lives in the Rust LSP host — no sidecar involvement. Child processes are spawned and managed directly from Rust.

The implementation is phased: get process discovery and basic tracing working first, then layer on counters and memory analysis. Ship early, iterate.

## TODO

### Phase A — Tool Discovery and Process Listing

- [x] Add `[profiler]` section to `forge.toml` config schema in `src/config.rs`
- [x] Create `src/profiler.rs` module (re-export submodules)
- [x] Create `src/profiler/tool_discovery.rs` — locate `dotnet-trace`, `dotnet-counters`, `dotnet-dump` on PATH and via `dotnet tool list -g`
- [x] Cache discovered tool paths (lazy, first-use initialization)
- [x] Return actionable error with install command when tool is missing
- [x] Create `src/profiler/process_list.rs` — parse `dotnet-trace ps` output into `DotNetProcess` structs
- [x] Register `forge/profiler/listProcesses` custom LSP request handler
- [x] Add tracing logs for tool discovery and process listing
- [ ] E2E test: `forge/profiler/listProcesses` returns valid JSON array (may be empty in CI)

### Phase B — Trace Collection (dotnet-trace)

- [x] Create `src/profiler/session.rs` — `ProfileSession` struct, `DashMap<String, ProfileSession>` session store, UUID generation
- [x] Implement max concurrent session enforcement (default 5)
- [x] Create `src/profiler/trace.rs` — spawn `dotnet-trace collect` as child process
- [x] Support `profile`, `format`, `duration`, `outputPath` params
- [x] Register `forge/profiler/startTrace` custom LSP request handler
- [x] Register `forge/profiler/stopTrace` custom LSP request handler — send SIGINT/kill to child process, wait for output file
- [x] Handle timeout-based auto-stop (duration param)
- [x] Convert `.nettrace` to SpeedScope format post-collection (`dotnet-trace convert`)
- [x] Return output path and file size in stop response
- [x] Clean up orphaned sessions on LSP shutdown
- [x] Add tracing logs for session lifecycle (start, stop, error, timeout)
- [ ] E2E test: start trace → stop trace → verify output file exists (requires running .NET process in test harness)

### Phase C — Live Counter Monitoring (dotnet-counters)

- [x] Create `src/profiler/counters.rs` — spawn `dotnet-counters monitor` with `--format json`
- [x] Parse streaming JSON output from stdout line-by-line
- [x] Register `forge/profiler/startCounters` custom LSP request handler
- [x] Register `forge/profiler/stopCounters` custom LSP request handler
- [x] Stream `forge/profiler/counterUpdate` LSP notifications to editor
- [x] Support configurable providers and refresh interval
- [ ] E2E test: start counters → receive at least one counterUpdate notification → stop counters

### Phase D — Memory Dump Collection (dotnet-dump)

- [x] Create `src/profiler/dump.rs` — spawn `dotnet-dump collect`
- [x] Support `dumpType` param (full, heap, mini)
- [x] Register `forge/profiler/collectDump` custom LSP request handler
- [x] Return output path and file size
- [ ] Add progress notification during dump collection (large dumps can take time)
- [ ] E2E test: collect dump of test .NET process → verify dump file exists

### Phase E — Heap Analysis and Memory Leak Tracing

- [x] Create `src/profiler/heap_analysis.rs` — spawn `dotnet-dump analyze` with scripted commands
- [x] Implement `dumpheap -stat` output parsing into `HeapTypeInfo` structs
- [x] Support `limit` and `typeFilter` params
- [x] Register `forge/profiler/analyzeHeap` custom LSP request handler
- [x] Implement `gcroot` output parsing into `GCRootChain` structs
- [x] Register `forge/profiler/findGCRoots` custom LSP request handler
- [ ] E2E test: collect dump → analyzeHeap returns non-empty type list
- [ ] E2E test: collect dump → findGCRoots returns root chain for known object

### Phase F — VSCode Extension

- [x] Add profiler tree view to `package.json` (view container, views)
- [x] Implement `ProfilerTreeDataProvider` — shows .NET processes, active sessions
- [x] Add process refresh button to tree view
- [x] Register all 7 profiler commands in `package.json`
- [x] Implement `forge.profiler.listProcesses` command — quick pick process selector
- [x] Implement `forge.profiler.startTrace` command — prompt for profile, format, duration → call LSP
- [x] Implement `forge.profiler.stopTrace` command — select active session → call LSP → open output file
- [x] Implement `forge.profiler.startCounters` command — prompt for providers → call LSP
- [x] Implement `forge.profiler.stopCounters` command — select active session → call LSP
- [ ] Implement counter monitoring webview panel — live-updating table of counter values
- [ ] Handle `forge/profiler/counterUpdate` notifications → push to webview
- [x] Implement `forge.profiler.collectDump` command — prompt for dump type → call LSP
- [x] Implement `forge.profiler.analyzeHeap` command — select dump file → call LSP → show sortable table webview
- [ ] Add status bar item showing active profiling session count
- [ ] Open SpeedScope JSON files in browser after trace conversion
- [ ] E2E test: execute startTrace command → verify session appears in tree view
- [ ] E2E test: execute startCounters → verify counter webview opens and receives updates
- [ ] E2E test: execute collectDump → analyzeHeap → verify heap stats table renders

### Performance Validation

- [ ] Benchmark process list refresh — target <500ms
- [ ] Benchmark trace start latency — target <1s
- [ ] Benchmark counter update delivery latency — target <100ms from tool output to editor
- [ ] Benchmark heap analysis on dump with 50k+ types — target <5s
- [ ] Benchmark GC root traversal — target <10s
