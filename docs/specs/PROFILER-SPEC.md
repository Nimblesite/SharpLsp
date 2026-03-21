# Profiler Integration Specification

**Parent:** [FORGE-SPEC.md](FORGE-SPEC.md)

## 1. Overview

Forge integrates .NET diagnostic tools (`dotnet-trace`, `dotnet-counters`, `dotnet-dump`) directly into the editor via LSP custom requests, giving developers a simple UI around the standard .NET diagnostics CLI. No external tools, no terminal juggling — profile, trace, and analyze memory leaks from your editor.

**Reference:** [dotnet-trace documentation](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/dotnet-trace)

**Priority:** P2 (Phase 5 — Superiority)

## 2. Diagnostic Tools

### 2.1 dotnet-trace

Collects performance traces from running .NET processes using EventPipe. Produces `.nettrace` files convertible to Chromium/SpeedScope formats for visualization.

| Capability | CLI Equivalent | Description |
|-----------|---------------|-------------|
| List processes | `dotnet-trace ps` | Discover running .NET processes |
| Collect trace | `dotnet-trace collect -p <pid>` | Attach and record EventPipe trace |
| Stop trace | Ctrl+C equivalent | Gracefully stop collection |
| Convert trace | `dotnet-trace convert` | Convert `.nettrace` to `.speedscope.json` or Chromium format |

### 2.2 dotnet-counters

Real-time monitoring of .NET runtime performance counters (GC, CPU, exceptions, thread pool).

| Capability | CLI Equivalent | Description |
|-----------|---------------|-------------|
| List processes | `dotnet-counters ps` | Discover running .NET processes |
| Monitor counters | `dotnet-counters monitor -p <pid>` | Stream live counter values |
| Collect counters | `dotnet-counters collect -p <pid>` | Record counters to CSV/JSON |

### 2.3 dotnet-dump (Memory Leak Tracing)

Captures and analyzes process dumps for memory leak investigation without a native debugger.

| Capability | CLI Equivalent | Description |
|-----------|---------------|-------------|
| Collect dump | `dotnet-dump collect -p <pid>` | Capture managed heap dump |
| Analyze dump | `dotnet-dump analyze <file>` | Open interactive analysis session |
| Heap stats | `dumpheap -stat` | Show object type counts and sizes |
| GC roots | `gcroot <addr>` | Trace GC root references for an object |
| Object references | `dumpobj <addr>` | Inspect individual managed objects |

## 3. Architecture

### 3.1 Component Placement

Profiler integration lives in the **Rust LSP host** (Tier 1). The diagnostic CLI tools run as child processes managed by the host — no sidecar involvement.

```
Editor  ──LSP custom request──▶  Rust Host  ──spawns──▶  dotnet-trace / dotnet-counters / dotnet-dump
                                     │
                                     ├── Process discovery (dotnet-trace ps)
                                     ├── Session lifecycle (start / stop / convert)
                                     └── Output parsing + streaming to editor
```

### 3.2 Why Rust Host, Not Sidecar

- Diagnostic tools are standalone CLI executables, not Roslyn/FCS APIs
- No workspace or compilation context needed
- Direct process spawning from Rust is simpler and lower latency
- Sidecar crash must not kill profiling sessions

### 3.3 Tool Discovery

On startup (lazy, first use), the host locates diagnostic tools:

| Step | Action | Fallback |
|------|--------|----------|
| 1 | Check `PATH` for `dotnet-trace`, `dotnet-counters`, `dotnet-dump` | — |
| 2 | Check `dotnet tool list -g` output | — |
| 3 | If missing, prompt user to install via `dotnet tool install -g` | Return error with install instructions |

## 4. LSP Custom Requests

All profiler requests use the `forge/` namespace.

### 4.1 Process Discovery

**Method:** `forge/profiler/listProcesses`

**Params:**
```typescript
interface ListProcessesParams {}
```

**Result:**
```typescript
interface DotNetProcess {
  pid: number;
  name: string;
  commandLine: string;
}

type ListProcessesResult = DotNetProcess[];
```

Calls `dotnet-trace ps` and parses output. Returns all discoverable .NET processes.

### 4.2 Trace Session

**Method:** `forge/profiler/startTrace`

**Params:**
```typescript
interface StartTraceParams {
  pid: number;
  /** EventPipe profile: "cpu-sampling", "gc-verbose", "gc-collect", or custom provider string */
  profile?: string;
  /** Output format: "nettrace" | "speedscope" | "chromium". Default: "speedscope" */
  format?: string;
  /** Max duration in seconds. 0 = unlimited. Default: 30 */
  duration?: number;
  /** Output file path. Auto-generated if omitted */
  outputPath?: string;
}
```

**Result:**
```typescript
interface StartTraceResult {
  sessionId: string;
  outputPath: string;
}
```

**Method:** `forge/profiler/stopTrace`

**Params:**
```typescript
interface StopTraceParams {
  sessionId: string;
}
```

**Result:**
```typescript
interface StopTraceResult {
  outputPath: string;
  fileSizeBytes: number;
  durationMs: number;
}
```

### 4.3 Counter Monitoring

**Method:** `forge/profiler/startCounters`

**Params:**
```typescript
interface StartCountersParams {
  pid: number;
  /** Counter providers. Default: ["System.Runtime"] */
  providers?: string[];
  /** Refresh interval in seconds. Default: 1 */
  refreshInterval?: number;
}
```

**Result:**
```typescript
interface StartCountersResult {
  sessionId: string;
}
```

Counter values streamed via LSP notification:

**Notification:** `forge/profiler/counterUpdate`

```typescript
interface CounterUpdateParams {
  sessionId: string;
  counters: CounterValue[];
}

interface CounterValue {
  provider: string;
  name: string;
  displayName: string;
  value: number;
  unit: string;
}
```

**Method:** `forge/profiler/stopCounters`

**Params:**
```typescript
interface StopCountersParams {
  sessionId: string;
}
```

### 4.4 Memory Dump Collection

**Method:** `forge/profiler/collectDump`

**Params:**
```typescript
interface CollectDumpParams {
  pid: number;
  /** Dump type: "full" | "heap" | "mini". Default: "heap" */
  dumpType?: string;
  /** Output file path. Auto-generated if omitted */
  outputPath?: string;
}
```

**Result:**
```typescript
interface CollectDumpResult {
  outputPath: string;
  fileSizeBytes: number;
}
```

### 4.5 Memory Dump Analysis

**Method:** `forge/profiler/analyzeHeap`

**Params:**
```typescript
interface AnalyzeHeapParams {
  dumpPath: string;
  /** Max rows to return. Default: 50 */
  limit?: number;
  /** Filter by type name substring */
  typeFilter?: string;
}
```

**Result:**
```typescript
interface HeapStats {
  totalObjects: number;
  totalSizeBytes: number;
  types: HeapTypeInfo[];
}

interface HeapTypeInfo {
  typeName: string;
  count: number;
  totalSizeBytes: number;
}
```

**Method:** `forge/profiler/findGCRoots`

**Params:**
```typescript
interface FindGCRootsParams {
  dumpPath: string;
  /** Object address (hex string) */
  objectAddress: string;
}
```

**Result:**
```typescript
interface GCRootChain {
  roots: GCRootNode[];
}

interface GCRootNode {
  address: string;
  typeName: string;
  rootKind: string;
}

type FindGCRootsResult = GCRootChain[];
```

## 5. Memory Leak Tracing Workflow

Memory leak investigation follows a structured workflow exposed through the UI:

### 5.1 Baseline → Exercise → Compare

| Step | Action | Tool |
|------|--------|------|
| 1 | Collect baseline heap dump | `forge/profiler/collectDump` |
| 2 | Exercise the suspected leak path | (user action) |
| 3 | Collect second heap dump | `forge/profiler/collectDump` |
| 4 | Compare heap stats between dumps | `forge/profiler/analyzeHeap` on both |
| 5 | Identify growing types | Editor diff view of heap stats |
| 6 | Trace GC roots of suspect objects | `forge/profiler/findGCRoots` |

### 5.2 Live Counter Monitoring for Leak Detection

Monitor `System.Runtime` counters to detect leaks in real-time:

| Counter | Leak Signal |
|---------|-------------|
| `gc-heap-size` | Monotonically increasing across Gen 2 collections |
| `gen-2-gc-count` | Unusually high frequency |
| `number-of-active-timers` | Growing without bound |
| `threadpool-queue-length` | Sustained growth |

The editor highlights counters that show sustained growth patterns.

## 6. Session Management

### 6.1 Session Lifecycle

```
Created  ──start──▶  Running  ──stop──▶  Stopped  ──cleanup──▶  Disposed
                        │
                        └──timeout──▶  Stopped
                        └──error──▶  Failed
```

- Each session gets a unique ID (UUID v4)
- Sessions tracked in a `DashMap<String, ProfileSession>` on the Rust host
- Maximum concurrent sessions: 5 (configurable via `forge.toml`)
- Orphaned sessions (editor disconnect) cleaned up on LSP shutdown

### 6.2 Configuration

`forge.toml` settings:

```toml
[profiler]
max_concurrent_sessions = 5
default_trace_duration = 30
default_trace_format = "speedscope"
default_counter_providers = ["System.Runtime"]
default_counter_interval = 1
output_directory = ".forge/profiles"
```

## 7. Editor Integration

### 7.1 VSCode Extension

| UI Element | Purpose |
|-----------|---------|
| Tree view panel | List running .NET processes, active sessions |
| Status bar item | Show active profiling session count |
| Command palette | Start/stop trace, start/stop counters, collect dump |
| Webview panel | Display counter values as live-updating table |
| Webview panel | Display heap stats as sortable table |
| Quick pick | Process selection from discovered .NET processes |
| File open | Open `.speedscope.json` output in browser/SpeedScope viewer |

### 7.2 Commands

| Command | Title |
|---------|-------|
| `forge.profiler.listProcesses` | Forge: List .NET Processes |
| `forge.profiler.startTrace` | Forge: Start Performance Trace |
| `forge.profiler.stopTrace` | Forge: Stop Performance Trace |
| `forge.profiler.startCounters` | Forge: Start Counter Monitoring |
| `forge.profiler.stopCounters` | Forge: Stop Counter Monitoring |
| `forge.profiler.collectDump` | Forge: Collect Memory Dump |
| `forge.profiler.analyzeHeap` | Forge: Analyze Heap Dump |

## 8. Performance Requirements

| Metric | Target |
|--------|--------|
| Process list refresh | <500ms |
| Trace start latency | <1s (tool spawn + attach) |
| Counter update delivery | <100ms from tool output to editor notification |
| Dump collection | Depends on process size; UI must show progress |
| Heap analysis (50k types) | <5s |
| GC root traversal | <10s |

## 9. Error Handling

| Condition | Response |
|-----------|----------|
| Diagnostic tool not installed | Return error with `dotnet tool install` command |
| Target process exited | Stop session, notify editor, return partial data |
| Permission denied (attach) | Return error with elevation instructions |
| Trace file write failure | Return error with path and OS error |
| Session limit exceeded | Return error listing active sessions |
| Tool produces unexpected output | Log raw output at `warn` level, return parse error |
| Editor disconnects during session | Clean up all sessions on LSP shutdown |

## 10. Competitive Parity Matrix

| Feature | VS | Rider | CDK | Forge Target | Priority |
|---------|----|----|-----|-------------|----------|
| CPU trace collection | Yes | Yes | No | Yes | P0 |
| Live performance counters | Yes (PerfView) | Yes | No | Yes | P0 |
| Memory dump collection | Yes | Yes | No | Yes | P0 |
| Heap analysis | Yes | Yes (dotMemory) | No | Yes (basic) | P1 |
| GC root analysis | Yes | Yes (dotMemory) | No | Yes (basic) | P1 |
| Leak detection heuristics | Partial | Yes | No | Yes (counter-based) | P2 |
| Flame graph visualization | External | Built-in | No | External (SpeedScope) | P1 |
| Allocation tracking | Yes | Yes (dotTrace) | No | Future | P2 |
| Object retention graph | Yes | Yes (dotMemory) | No | Future | P2 |
