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
- [x] E2E test: `forge/profiler/listProcesses` returns valid JSON array (may be empty in CI)

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
- [x] E2E test: startTrace with invalid PID returns error without crashing

### Phase C — Live Counter Monitoring (dotnet-counters)

- [x] Create `src/profiler/counters.rs` — spawn `dotnet-counters monitor` with `--format json`
- [x] Parse streaming JSON output from stdout line-by-line
- [x] Register `forge/profiler/startCounters` custom LSP request handler
- [x] Register `forge/profiler/stopCounters` custom LSP request handler
- [x] Stream `forge/profiler/counterUpdate` LSP notifications to editor
- [x] Support configurable providers and refresh interval
- [x] E2E test: stopCounters with unknown session returns error without crashing

### Phase D — Memory Dump Collection (dotnet-dump)

- [x] Create `src/profiler/dump.rs` — spawn `dotnet-dump collect`
- [x] Support `dumpType` param (full, heap, mini)
- [x] Register `forge/profiler/collectDump` custom LSP request handler
- [x] Return output path and file size
- [x] Add progress notification during dump collection (large dumps can take time)
- [x] E2E test: collectDump with invalid PID returns error without crashing

### Phase E — Heap Analysis and Memory Leak Tracing

- [x] Create `src/profiler/heap_analysis.rs` — spawn `dotnet-dump analyze` with scripted commands
- [x] Implement `dumpheap -stat` output parsing into `HeapTypeInfo` structs
- [x] Support `limit` and `typeFilter` params
- [x] Register `forge/profiler/analyzeHeap` custom LSP request handler
- [x] Implement `gcroot` output parsing into `GCRootChain` structs
- [x] Register `forge/profiler/findGCRoots` custom LSP request handler
- [x] E2E test: analyzeHeap with missing dump file returns error without crashing
- [x] E2E test: findGCRoots with missing dump file returns error without crashing

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
- [x] Implement counter monitoring webview panel — live-updating table of counter values
- [x] Handle `forge/profiler/counterUpdate` notifications → push to webview
- [x] Implement `forge.profiler.collectDump` command — prompt for dump type → call LSP
- [x] Implement `forge.profiler.analyzeHeap` command — select dump file → call LSP → show sortable table webview
- [x] Add status bar item showing active profiling session count
- [x] Open SpeedScope JSON files in browser after trace conversion
- [x] E2E test: execute startTrace command → verify session appears in tree view
- [x] E2E test: execute startCounters → verify counter webview opens and receives updates
- [x] E2E test: execute collectDump → analyzeHeap → verify heap stats table renders

### Performance Validation

- [x] Benchmark process list refresh — target <500ms
- [x] Benchmark trace start latency — target <1s
- [x] Benchmark counter update delivery latency — target <100ms from tool output to editor
- [x] Benchmark heap analysis on dump with 50k+ types — target <5s
- [x] Benchmark GC root traversal — target <10s

### Phase G — Automated Leak Detection (Heap Snapshot Diffing)

- [ ] Create `src/profiler/heap_diff.rs` — diff two `dumpheap -stat` results
- [ ] Implement `HeapTypeDiff` calculation (count delta, size delta, growth percent)
- [ ] Implement leak suspect classification (high/medium/low severity heuristics)
- [ ] Flag known leak-prone patterns (event handlers, delegates, `CancellationTokenSource`, timers, growing collections)
- [ ] Register `forge/profiler/diffHeapSnapshots` custom LSP request handler
- [ ] E2E test: diff two dumps from ProfileTarget — one before allocations, one after — detect growth
- [ ] E2E test: verify leak suspects include types with >100% growth
- [ ] E2E test: verify `growingOnly` filter excludes shrinking types
- [ ] E2E test: verify `minGrowthPercent` threshold filtering

### Phase H — Object Inspection

- [x] Create `src/profiler/object_inspection.rs` — parse `dumpobj <addr>` output into `ObjectInspection`
- [x] Parse field names, types, values, and reference addresses from `dumpobj` output
- [x] Detect object generation (Gen 0/1/2, LOH, POH) and pinned status
- [x] Register `forge/profiler/inspectObject` custom LSP request handler
- [x] E2E test: inspect a known object address from a dump — verify fields are populated
- [x] Unit test: parse `dumpobj` output with primitive fields, reference fields, and array elements

### Phase I — Object Retention Graph

- [ ] Create `src/profiler/object_graph.rs` — build graph from `dumpobj` + `gcroot` + `objsize`
- [ ] Implement breadth-first traversal from root address with depth limit
- [ ] Parse `dumpobj` output to extract field references for edge construction
- [ ] Use `objsize` to calculate retained size per node
- [ ] Use `gcroot` to annotate root nodes (Static, ThreadLocal, Pinned, Finalizer, Stack)
- [ ] Implement `maxNodes` truncation with `truncated` flag in stats
- [ ] Implement `typeFilter` to prune graph to paths containing specific type
- [ ] Register `forge/profiler/getObjectGraph` custom LSP request handler
- [ ] E2E test: build graph from ProfileTarget dump — verify nodes and edges are returned
- [ ] E2E test: verify depth limiting works (depth=1 returns fewer nodes than depth=3)
- [ ] E2E test: verify type filter reduces node count
- [ ] Unit test: parse `dumpobj` output into graph nodes with correct field-name edges
- [ ] Unit test: parse `objsize` output for retained size

### Phase J — Object Graph Webview (VSCode Extension)

- [ ] Create `editors/vscode/src/profiler-graph.ts` — webview panel for object graph
- [ ] Implement D3.js force-directed graph layout with physics simulation
- [ ] Color coding: red (leak suspect), orange (large retained), blue (GC root), gray (normal)
- [ ] Node sizing proportional to retained size
- [ ] Click-to-expand: lazy load children via `getObjectGraph` with deeper depth
- [ ] Right-click to inspect: show `inspectObject` result in panel
- [ ] Hover tooltip: type name, size, instance count, retained size
- [ ] Type filter text input to show/hide nodes
- [ ] Double-click to collapse/expand subtrees
- [ ] Highlight shortest GC root path when clicking a leaf node
- [ ] Search by type name or address
- [ ] Export graph as SVG or PNG
- [ ] Depth slider control (1–10)
- [ ] Register `forge.profiler.showObjectGraph` command
- [ ] Content Security Policy for webview (only allow D3 from bundled script)

### Phase K — Heap Diff Webview and Leak Detection UI (VSCode Extension)

- [ ] Create `editors/vscode/src/profiler-diff.ts` — webview panel for heap diff table
- [ ] Sortable table columns (type, count delta, size delta, growth %, severity)
- [ ] Color-coded severity indicators (red/orange/yellow badges)
- [ ] Click a row to show object graph for that type's instances
- [ ] "Detect Leaks" command: guided workflow (collect baseline → prompt user → collect comparison → diff → show results)
- [ ] Register `forge.profiler.diffSnapshots` and `forge.profiler.detectLeaks` commands
- [ ] In graph view, annotate nodes from diff with growth indicators (pulsing border, size deltas)
- [ ] Register `forge.profiler.inspectObject` command — opens inspection panel from graph context menu

### Performance Validation (Phase G–K)

- [ ] Benchmark heap diff (two 50k-type dumps) — target <10s
- [ ] Benchmark object graph (depth 3, 200 nodes) — target <3s
- [ ] Benchmark object graph (depth 5, 200 nodes) — target <8s
- [ ] Benchmark object inspection — target <500ms
- [ ] Benchmark retained size calculation — target <5s per node
- [ ] Benchmark graph webview initial render — target <500ms
- [ ] Benchmark graph webview node expansion — target <1s
