# DEBUGGING-SPEC

**Forge Debugging Technical Specification**

*March 2026 | DRAFT*

---

## 1. Mission

Forge must deliver a top-tier .NET debugging experience that is fully open-source, editor-agnostic, and license-free. Microsoft's proprietary `vsdbg` is explicitly forbidden by its license from use in any editor except Visual Studio, Visual Studio Code (Microsoft-signed binary), and Visual Studio for Mac. Forge must match or exceed the vsdbg experience using only open-source infrastructure.

The benchmark is brutal: a developer coming from `vsdbg` must not feel degraded. Every mainstream debugging workflow must work. Gaps in open-source tooling that we cannot close by configuration must be closed by engineering.

---

## 2. Debugger Adapter Selection

### 2.1 The Landscape

| Debugger | License | Architecture | Production-Ready | Gaps |
|---|---|---|---|---|
| **vsdbg** (Microsoft) | **Proprietary — FORBIDDEN** | C++ over ICorDebug | Yes | Cannot redistribute; license explicitly bars non-VS-Code products |
| **netcoredbg** (Samsung) | MIT | C++ over ICorDebug + DAP | Mostly | Expression eval, async stacks, logpoints, EnC on Linux/macOS |
| **SharpDbg** (MattParkerDev) | MIT | C# over ClrDebug (managed ICorDebug) | No (preview 0.1.x) | Pre-production; missing most features |
| **Mono SDB** | MIT | Mono runtime agent over TCP | Yes (Mono only) | Incompatible with CoreCLR; not applicable |
| **Rider debugger** (JetBrains) | Proprietary | Java + .NET, IntelliJ-coupled | Yes | Not redistributable; tightly coupled to IntelliJ platform |

**Decision: netcoredbg is the primary debugger for Phase 4, with a parallel investment in a Forge-native C# Debug Sidecar (Tier 4) targeting full vsdbg parity.**

### 2.2 Why netcoredbg

- Only MIT-licensed CoreCLR debugger with production DAP support
- Implements the full DAP protocol over stdin/stdout — drop-in compatible with any editor
- Used in production by VSCodium, Neovim, Helix, and MonoDevelop communities
- Actively maintained by Samsung's Linux Platform team (latest release 3.1.3-1062, December 2025)
- Covers all P1 debugging scenarios: line/conditional/function/exception breakpoints, step in/over/out, variable inspection, call stack navigation
- Runs on Linux, macOS (x64 and ARM64 with community builds), and Windows

### 2.3 Why Not Stop at netcoredbg

netcoredbg has real, material gaps versus vsdbg. These are not cosmetic. The following are confirmed missing or broken:

| Gap | Impact |
|---|---|
| No logical async call stack reconstruction | Daily pain in async-heavy codebases; physical stack only |
| Expression evaluator incomplete (LINQ, complex lambdas fail) | Watch window workflows break on real enterprise code |
| No logpoints | Cannot inject trace messages without pausing execution |
| No data breakpoints | Cannot break on field/property value changes |
| Edit and Continue: Linux/macOS not supported | Productivity regression vs. Windows/Visual Studio |
| No remote debugging (SSH) built-in | Requires manual tunnel setup |
| No return value display | Cannot inspect method return values on step-over |
| Attach to process: unreliable | Intermittent failures; open issues since 2024 |
| macOS ARM64: community-only, not officially supported | Fails on Apple Silicon without manual workarounds |
| musl/Alpine: breakpoints silently ignored in some builds | Docker-based dev workflows broken |
| No parallel stacks data | Multi-threaded debugging crippled |

The Forge answer is a **two-phase approach**:
1. **Phase 4**: Ship netcoredbg integration, closing the most impactful gaps via Forge-side workarounds and contributions to netcoredbg upstream
2. **Phase 5**: Ship the Forge Debug Sidecar — a C# Tier 4 process built on `ClrDebug` + `ICorDebug` that achieves full vsdbg feature parity

---

## 3. Architecture

### 3.1 System Topology

```
┌────────────────────────────────────────────────────────────────────┐
│  Editor (VS Code, Neovim, Helix, Zed, Emacs, …)                   │
│  DAP JSON-RPC over stdio/socket                                    │
└───────────────────────────┬────────────────────────────────────────┘
                            │ DAP (JSON-RPC)
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  Tier 1: Rust LSP/DAP Host (forge)                                │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  DapRouter                                                   │ │
│  │  - Proxies DAP to active debug adapter                       │ │
│  │  - Augments: logpoints → breakpoints+eval, async stacks      │ │
│  │  - Manages adapter lifecycle (spawn, health, restart)        │ │
│  │  - Multiplexes multi-process debug sessions                  │ │
│  └──────────────────────┬───────────────────────────────────────┘ │
└─────────────────────────┼──────────────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          │                               │
          ▼ Phase 4                       ▼ Phase 5
┌─────────────────────┐       ┌──────────────────────────────────┐
│  netcoredbg         │       │  Tier 4: Forge Debug Sidecar     │
│  (external process) │       │  (C# process)                    │
│  DAP stdin/stdout   │       │  ClrDebug + ICorDebug + DbgShim  │
│  MIT licensed       │       │  DAP stdin/stdout                │
└──────────┬──────────┘       └──────────────────┬───────────────┘
           │                                      │
           └───────────────┬──────────────────────┘
                           │ ICorDebug / DbgShim
                           ▼
                ┌─────────────────────┐
                │  Target .NET Process│
                │  (CoreCLR runtime)  │
                └─────────────────────┘
```

### 3.2 Rust DapRouter

The Rust host runs a `DapRouter` module responsible for:

- **Adapter lifecycle**: spawning/monitoring netcoredbg (Phase 4) or the Debug Sidecar (Phase 5), auto-restart on crash
- **DAP proxy**: forwarding DAP messages between the editor and the active adapter with minimal latency
- **Capability augmentation**: intercepts DAP `initialize` responses to advertise capabilities the underlying adapter lacks but Forge implements at the proxy layer (logpoints, async stack enrichment)
- **Logpoint emulation**: translates DAP `setBreakpoints` logpoint requests into netcoredbg conditional breakpoints that evaluate + log + continue
- **Async stack enrichment**: post-processes `stackTrace` responses, reconstructing logical async frames using state-machine field analysis via the C# sidecar (Roslyn)
- **Multi-session management**: maintains a registry of active debug sessions for multi-process/multi-project scenarios
- **Hot Reload coordination**: integrates with `dotnet watch` / the .NET runtime's `ApplyUpdate` API for hot reload during debug sessions

### 3.3 netcoredbg Integration (Phase 4)

netcoredbg is managed as an external subprocess:

- **Distribution**: bundled with Forge release artifacts (platform-specific binary), or auto-downloaded on first debug launch if not present
- **Version pinning**: Forge pins a specific netcoredbg release (currently 3.1.3-1062) and upgrades on a tested cadence
- **Transport**: DAP over stdin/stdout. The DapRouter opens the child process and pipes JSON-RPC
- **Launch modes**:
  - `launch`: spawn a new .NET process with `--attach false`
  - `attach`: attach to an existing PID (with known reliability caveats — see §6.3)
- **Platform matrix**:
  - Linux x64: official release binary
  - Linux ARM64: official release binary
  - macOS x64: official release binary
  - macOS ARM64: Forge builds from source in CI (Samsung does not officially support arm64)
  - Windows x64: official release binary
  - Alpine/musl: Forge maintains a musl-linked build via the netcoredbg Dockerfile

### 3.4 Forge Debug Sidecar (Phase 5)

A new C# process (Tier 4) that implements the full ICorDebug-based debugger natively, avoiding the C++ layer of netcoredbg:

- **Language**: C# 13 on .NET 9+, matching the existing sidecar architecture
- **Core dependency**: [`ClrDebug`](https://github.com/lordmilko/ClrDebug) — a managed type-safe wrapper for the ICorDebug COM API (MIT licensed)
- **Bootstrap**: `Microsoft.Diagnostics.DbgShim` NuGet package for runtime discovery and ICorDebug bootstrapping
- **Protocol**: DAP over stdin/stdout (same as netcoredbg, fully drop-in from the DapRouter's perspective)
- **IPC with Rust host**: MessagePack over Unix socket / named pipe for side-channel requests (async stack analysis, expression compilation via Roslyn)
- **Expression evaluation**: delegates complex expression compilation to the C# sidecar (Tier 2, Roslyn) — the Debug Sidecar submits an expression, Roslyn compiles it to IL, and the Debug Sidecar evaluates the IL via `ICorDebugEval`
- **Async stack reconstruction**: the Debug Sidecar reads state-machine fields from heap objects and reconstructs the logical async continuation chain

---

## 4. Feature Specification

### 4.1 Launch and Attach

| Feature | DAP Method | Priority | Notes |
|---|---|---|---|
| Launch .NET app (console, web, etc.) | `launch` | P1 | Pass args, env, cwd, program |
| Attach to running process by PID | `attach` | P1 | Known reliability issues in netcoredbg; fixed in Debug Sidecar |
| Attach to running process by name | `attach` (processName) | P2 | Forge resolves name → PID |
| Remote attach via SSH tunnel | `attach` (remote) | P2 | Forge manages SSH tunnel; adapter connects locally |
| Launch with environment variables | `launch` (env) | P1 | |
| Launch with custom working directory | `launch` (cwd) | P1 | |
| Launch browser for Blazor WASM | `launch` (browser) | P3 | Requires browser devtools bridge |
| Hot Reload enabled launch | `launch` (hotReload: true) | P2 | See §4.9 |

**Launch configuration schema** (`launch.json` / inline config):

```json
{
  "type": "forge",
  "request": "launch",
  "program": "${workspaceFolder}/bin/Debug/net9.0/MyApp.dll",
  "args": [],
  "cwd": "${workspaceFolder}",
  "env": {},
  "stopAtEntry": false,
  "console": "integratedTerminal",
  "hotReload": false,
  "justMyCode": true,
  "requireExactSource": true,
  "symbolOptions": {
    "searchPaths": [],
    "searchMicrosoftSymbolServer": false
  }
}
```

### 4.2 Breakpoints

| Feature | DAP Method | Priority | Implementation |
|---|---|---|---|
| Line breakpoints | `setBreakpoints` | P1 | Native in netcoredbg / Debug Sidecar |
| Function/method breakpoints | `setFunctionBreakpoints` | P1 | Native |
| Exception breakpoints (all / unhandled) | `setExceptionBreakpoints` | P1 | Native |
| Conditional breakpoints (C# expression) | `setBreakpoints` (condition) | P1 | Native in netcoredbg; full support in Debug Sidecar |
| Hit-count breakpoints | `setBreakpoints` (hitCondition) | P1 | Native |
| Logpoints (tracepoints) | `setBreakpoints` (logMessage) | P1 | Emulated at DapRouter layer in Phase 4; native in Phase 5 |
| Data breakpoints (field value change) | `setDataBreakpoints` | P2 | Phase 5 only (Debug Sidecar) |
| Instruction breakpoints (address) | `setInstructionBreakpoints` | P3 | Phase 5; requires disassembly support |
| Breakpoint groups / labels | Client-side | P3 | Editor feature, no adapter change needed |

**Logpoint emulation (Phase 4):**

netcoredbg does not support logpoints natively. The DapRouter intercepts `setBreakpoints` requests containing `logMessage`, rewrites them as conditional breakpoints with an `ICorDebug` expression that evaluates `Console.Error.WriteLine(…)` and always returns `false` (never pauses), then forwards to netcoredbg. The output is captured from the debug output channel. This is a known workaround used by netcoredbg forks; Forge makes it transparent.

### 4.3 Stepping

| Feature | DAP Method | Priority |
|---|---|---|
| Step over | `next` | P1 |
| Step into | `stepIn` | P1 |
| Step out | `stepOut` | P1 |
| Step back (reverse) | `stepBack` | P3 — Phase 5+ only; requires runtime support |
| Restart frame | `restartFrame` | P2 — Phase 5 |
| Run to cursor (temporary breakpoint) | `goto` | P2 |
| Just My Code (skip non-user code on step) | launch config | P1 |

**Just My Code implementation**: netcoredbg has basic Just My Code support via `justMyCode: true` in launch config. The Debug Sidecar implements full JMC by checking `[DebuggerNonUserCode]`, `[DebuggerHidden]`, and `[GeneratedCode]` attributes on methods/types, using the same logic as vsdbg.

### 4.4 Call Stack

| Feature | DAP Method | Priority | Notes |
|---|---|---|---|
| Call stack display | `stackTrace` | P1 | Physical frames |
| Logical async call stack | `stackTrace` (enriched) | P1 | Forge reconstructs via Roslyn analysis (see §4.4.1) |
| Navigate to source from frame | `source` | P1 | |
| Load symbols on demand | — | P2 | PDB loading, symbol server |
| Decompiled source navigation | — | P2 | ICSharpCode.Decompiler in C# sidecar |
| Parallel Stacks data | custom | P2 | Phase 5; enumerate all thread stacks |

#### 4.4.1 Async Call Stack Reconstruction

This is the most impactful gap in netcoredbg. When code is paused inside an async state machine, the physical call stack only shows the MoveNext frame — not the logical chain of `await` continuations.

**Reconstruction algorithm (implemented in C# sidecar, called by DapRouter):**

1. DapRouter receives a `stopped` event from netcoredbg
2. DapRouter requests `stackTrace` from netcoredbg; identifies frames where the method name ends in `MoveNext` on a compiler-generated type (`<...>d__N`)
3. For each such frame, DapRouter sends a side-channel request to the C# sidecar with the type name and the object address (`this` pointer from the frame locals)
4. C# sidecar uses Roslyn's compilation model to resolve the state machine type, extracts the `<>1__state` field value and the `<>4__this` (captured `this`) from heap via `ICorDebugValue` traversal
5. C# sidecar walks the continuation chain: reads the `_continuation` / `MoveNextRunner` field from the `AsyncTaskMethodBuilder`'s `_builder` to find the next frame in the logical chain
6. Reconstructed logical frames are injected into the `stackTrace` response before it is forwarded to the editor

This reconstruction is best-effort: it degrades gracefully (shows physical stack) when compiler-generated fields cannot be resolved.

### 4.5 Variables and Inspection

| Feature | DAP Method | Priority |
|---|---|---|
| Local variables | `variables` | P1 |
| Function arguments | `variables` | P1 |
| `this` / instance members | `variables` | P1 |
| Static fields | `variables` | P1 |
| Collection/array expansion | `variables` (structured) | P1 |
| Custom type display (`DebuggerDisplay`) | `variables` | P1 |
| `DebuggerTypeProxy` expansion | `variables` | P2 |
| Modify variable value at runtime | `setVariable` | P1 |
| Hover expression evaluation | `evaluate` (hover) | P1 |
| Watch window evaluation | `evaluate` (watch) | P1 |
| Immediate window / REPL evaluation | `evaluate` (repl) | P2 |
| Return value display on step-over | custom event | P2 — Phase 5 |
| Raw memory view | `readMemory` / `writeMemory` | P3 — Phase 5 |

**Expression evaluation quality tiers:**

| Tier | Scenario | Phase 4 (netcoredbg) | Phase 5 (Debug Sidecar) |
|---|---|---|---|
| T1 | Simple field/property access | Works | Works |
| T1 | Arithmetic, string concat | Works | Works |
| T1 | Null checks, type casts | Works | Works |
| T2 | Method calls on locals | Works | Works |
| T2 | Extension methods | Partial | Works |
| T3 | LINQ queries on live objects | Fails (netcoredbg) | Works (Roslyn → ICorDebugEval) |
| T3 | Multi-statement lambdas | Fails | Works |
| T3 | Generic type inference in expressions | Fails | Works |
| T3 | `dynamic` type evaluation | Fails | Partial |

The Debug Sidecar achieves T3 by delegating expression compilation to the C# sidecar (Roslyn ScriptingWorkspace), receiving compiled IL, injecting it as an in-memory assembly, and evaluating via `ICorDebugEval`. This is the same approach used by vsdbg.

### 4.6 Exception Handling

| Feature | Priority |
|---|---|
| Break on all CLR exceptions | P1 |
| Break on unhandled exceptions only | P1 |
| Break on specific exception types (include/exclude filter) | P1 |
| Break on exceptions from user code only | P1 |
| Exception info panel (type, message, stack) | P1 |
| Inner exception traversal | P2 |
| Exception conditions (break only if message matches) | P2 — Phase 5 |

Configuration via `setExceptionBreakpoints` with `filterOptions` and `exceptionOptions` per the DAP specification.

### 4.7 Conditional Breakpoints and Logpoints

**Conditional breakpoints:**

- C# expression evaluated in the context of the paused frame
- Expression compiled by Roslyn (C# sidecar) in Phase 5 for full language support
- In Phase 4, expression is passed verbatim to netcoredbg's built-in evaluator (limited to T1/T2 tier expressions — see §4.5)
- Hit condition: `>`, `>=`, `<`, `<=`, `==`, `%` operators against hit counter

**Logpoints:**

- Interpolated string with `{expression}` placeholders evaluated in frame context
- Phase 4: emulated as conditional breakpoints that always continue (see §4.2)
- Phase 5: native `ICorDebugBreakpoint` + `ICorDebugEval` implementation, zero pause latency

### 4.8 Hot Reload During Debug

Hot Reload (Edit and Continue at the .NET level, not the legacy EnC) allows modifying method bodies at runtime without restarting the debug session.

**Architecture:**

- Forge monitors document changes via VFS
- On save (or explicit trigger), the C# sidecar compiles a delta: a pair of metadata delta + IL delta using `EmitDiff` from Roslyn's `Compilation.EmitDifference` API
- Forge's DapRouter calls the `ApplyUpdate` API (via `System.Reflection.Metadata.MetadataUpdater.ApplyUpdate`) in the target process
- The debug session continues without interruption; the next method invocation uses the new IL
- Constrained by .NET's Hot Reload limitations: method signature changes, type addition, generic method changes — these require restart

**Supported hot reload edits (per .NET runtime capabilities):**

| Edit Type | Supported |
|---|---|
| Method body change | Yes |
| Add new method to existing type | Yes |
| Add new static field | Yes |
| Add new class (non-generic) | Yes |
| Change method signature | No — requires restart |
| Add/remove generic type parameter | No — requires restart |
| Modify lambda captured variables | No — requires restart |

**Hot Reload vs Edit and Continue:**

.NET Hot Reload (`MetadataUpdater.ApplyUpdate`) is the successor to classic Edit and Continue (`ICorDebugModule2::ApplyChanges`). It is cross-platform and does not require ICorDebug. The Debug Sidecar uses Hot Reload, not legacy EnC. This is consistent with what Rider does on Linux/macOS.

### 4.9 Multi-Process and Multi-Project Debugging

| Feature | Priority |
|---|---|
| Multiple simultaneous debug sessions | P2 |
| Automatic child process attach (on fork/spawn) | P2 |
| Microservices compound launch (multiple launch configs) | P2 |
| Docker container attach | P2 |
| WSL process attach (Windows) | P3 |

**Implementation:** DapRouter maintains a `DebugSessionRegistry` indexed by session ID. Each session owns an independent adapter process. The editor communicates with multiple sessions via session-ID-prefixed DAP messages.

**Compound launch configs** allow defining a set of named launch configurations that start simultaneously, enabling a microservices stack to be started and debugged together from a single action.

### 4.10 Remote Debugging

**Approach:** Forge manages SSH tunnel setup transparently. The debug adapter always runs locally (against a forwarded socket), avoiding the complexity of cross-machine DAP transport.

| Step | Action |
|---|---|
| 1 | Forge SSH's to remote host, uploads netcoredbg / Debug Sidecar binary |
| 2 | Forge starts the adapter on the remote host listening on a port |
| 3 | Forge creates an SSH local port-forward for that port |
| 4 | DapRouter connects to the local end of the tunnel |
| 5 | Source files are mapped from remote paths to local paths via `sourceMap` config |

Source map configuration:

```json
{
  "type": "forge",
  "request": "attach",
  "processId": 1234,
  "remote": {
    "host": "prod-server.example.com",
    "port": 22,
    "user": "deploy"
  },
  "sourceFileMap": {
    "/app": "${workspaceFolder}"
  }
}
```

### 4.11 Performance Profiling Integration

Debugging and profiling are complementary. Forge integrates the .NET diagnostic tools alongside the debugger, accessible from the same debug session UI.

| Feature | Tool | Priority |
|---|---|---|
| CPU sampling profiler | `dotnet-trace` (EventPipe) | P2 |
| Memory allocation profiler | `dotnet-gcdump` + `dotnet-trace` | P2 |
| GC heap snapshot | `dotnet-gcdump` | P2 |
| Live counters (CPU, GC, requests/sec) | `dotnet-counters` | P2 |
| Process dump | `dotnet-dump` | P3 |
| Analyze core dumps | `dotnet-dump analyze` + SOS | P3 |

These are exposed as DAP custom events / `forge/profile*` notifications, surfaced in the editor as a profiler panel alongside the debugger panel. See `PROFILER-SPEC.md` for full profiler specification.

### 4.12 Test Debugging

| Feature | Protocol | Priority |
|---|---|---|
| Debug individual test | DAP + `forge/testDebug` | P1 |
| Debug test with args / env override | DAP + `forge/testDebug` | P2 |
| Breakpoints inside test method | Standard line breakpoints | P1 |
| Just My Code in test context | launch config | P1 |
| Debug entire test class/suite | DAP + `forge/testDebug` | P2 |

The test debug launch injects a `--no-build` `dotnet test` run with the debugger attached to the test host process, using the same DAP session as a regular launch.

---

## 5. DAP Capabilities Matrix

The following table documents which DAP capabilities Forge advertises per phase:

| Capability | Phase 4 | Phase 5 |
|---|---|---|
| `supportsConditionalBreakpoints` | Yes | Yes |
| `supportsHitConditionalBreakpoints` | Yes | Yes |
| `supportsLogPoints` | Yes (emulated) | Yes (native) |
| `supportsEvaluateForHovers` | Yes | Yes |
| `supportsSetVariable` | Yes | Yes |
| `supportsRestartFrame` | No | Yes |
| `supportsStepBack` | No | No (P3 — post Phase 5) |
| `supportsExceptionOptions` | Yes | Yes |
| `supportsDataBreakpoints` | No | Yes |
| `supportsReadMemoryRequest` | No | Yes |
| `supportsWriteMemoryRequest` | No | Yes |
| `supportsDisassembleRequest` | Partial | Yes |
| `supportsTerminateRequest` | Yes | Yes |
| `supportsRestartRequest` | Yes | Yes |
| `supportsSingleThreadExecutionRequests` | No | Yes |
| `supportsInstructionBreakpoints` | No | Yes |
| `supportsCompletionsRequest` | No | Yes (via Roslyn) |

---

## 6. Known Gaps and Closure Strategy

### 6.1 Async Call Stack (Phase 4 partial, Phase 5 complete)

**Gap:** netcoredbg shows physical call stack only. Async state machines appear as `MoveNext` frames.

**Closure:** DapRouter-level enrichment using C# sidecar analysis (§4.4.1). Phase 4 ships best-effort reconstruction. Phase 5 ships full reconstruction with the Debug Sidecar reading continuation chains directly.

### 6.2 Expression Evaluation (Phase 4 limited, Phase 5 full)

**Gap:** netcoredbg's expression evaluator fails on LINQ, complex lambdas, and multi-statement expressions.

**Closure:** Phase 5 Debug Sidecar delegates expression compilation to the Roslyn C# sidecar and evaluates via `ICorDebugEval`. This closes the gap fully for all C# expression types. F# expression evaluation requires FCS-based compilation in Phase 5.1.

### 6.3 Process Attach Reliability (Phase 4 improved, Phase 5 fixed)

**Gap:** netcoredbg `attach` mode has known reliability failures (issue #194 in the netcoredbg tracker).

**Closure:** Forge contributes a fix upstream. If not accepted, the DapRouter retries with exponential backoff and falls back to a different DbgShim attach path. The Debug Sidecar implements its own attach via `DbgShim.RegisterForRuntimeStartup` for clean, reliable attach.

### 6.4 macOS ARM64 (Phase 4 fixed, Phase 5 native)

**Gap:** netcoredbg does not officially support macOS ARM64 (Apple Silicon).

**Closure:** Forge CI builds netcoredbg from source for `darwin-arm64` and ships the binary. Phase 5 Debug Sidecar is .NET 9 managed code; no native compilation issues on ARM64.

### 6.5 musl/Alpine (Phase 4 fixed)

**Gap:** netcoredbg breakpoints silently fail on musl-linked builds.

**Closure:** Forge maintains a musl-linked netcoredbg build via Alpine Docker container in CI. Alpine target is a first-class supported platform.

### 6.6 Logpoints (Phase 4 emulated, Phase 5 native)

**Gap:** netcoredbg has no logpoint support.

**Closure:** DapRouter emulation (§4.2) ships in Phase 4. Phase 5 implements native logpoints with zero-pause semantics.

### 6.7 Edit and Continue / Hot Reload (Phase 4 Hot Reload only)

**Gap:** netcoredbg's Linux/macOS Edit and Continue does not work (issue #214). Classic EnC requires `ICorDebugModule2::ApplyChanges` which is not wired on POSIX.

**Closure:** Forge uses .NET Hot Reload (`MetadataUpdater.ApplyUpdate`) which is cross-platform, not classic EnC. Hot Reload is available in Phase 4. Classic EnC (Windows only, legacy) is explicitly out of scope — Hot Reload is the modern replacement.

### 6.8 Return Value Display (Phase 5)

**Gap:** netcoredbg returns limited return value information on step-over.

**Closure:** Phase 5 Debug Sidecar captures return values via `ICorDebugILFrame::GetReturnValueForILOffset` and synthesizes a `returnValue` pseudo-variable in the `variables` response.

### 6.9 Data Breakpoints (Phase 5)

**Gap:** netcoredbg does not support data breakpoints (break when a field changes value).

**Closure:** Phase 5 Debug Sidecar implements data breakpoints via field value polling on `ICorDebugManagedCallback::StepComplete` events, or via `ICorDebugProcess::SetUnmanagedBreakpoint` for platform-supported hardware watchpoints.

---

## 7. Security Considerations

- The debug adapter runs as the same user as the target process; Forge does not elevate privileges
- Remote debugging SSH keys are user-managed; Forge does not store credentials
- Process attach is guarded by OS-level ptrace permissions (Linux) / entitlement checks (macOS)
- Forge does not accept debug adapter connections from network interfaces (local sockets only)
- `dotnet-dump` output may contain sensitive heap data; Forge stores dumps in user-specified paths only

---

## 8. Performance Targets

| Metric | Target |
|---|---|
| Time from F5 to first breakpoint hit (cold) | <5s |
| Time from F5 to first breakpoint hit (warm) | <2s |
| Step latency (step over / step in / step out) | <200ms p95 |
| Variable panel population after stop | <300ms p95 |
| Conditional breakpoint expression evaluation | <100ms per evaluation |
| Logpoint output latency | <50ms (native Phase 5) |
| Hot Reload apply latency | <1s from save |
| Async stack reconstruction latency | <150ms |
| Attach to running process | <3s |

---

## 9. Dependencies

| Dependency | Version | License | Use |
|---|---|---|---|
| [netcoredbg](https://github.com/Samsung/netcoredbg) | 3.1.3-1062+ | MIT | Phase 4 debug adapter |
| [ClrDebug](https://github.com/lordmilko/ClrDebug) | latest | MIT | Phase 5 managed ICorDebug wrapper |
| [Microsoft.Diagnostics.DbgShim](https://www.nuget.org/packages/Microsoft.Diagnostics.DbgShim) | latest | MIT | DbgShim for runtime discovery |
| [Microsoft.Diagnostics.NETCore.Client](https://www.nuget.org/packages/Microsoft.Diagnostics.NETCore.Client) | latest | MIT | EventPipe / diagnostics IPC |
| [Microsoft.CodeAnalysis.CSharp.Scripting](https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp.Scripting) | 5.3.0+ | MIT | Expression compilation for eval |
| DAP specification | current | CC-BY 4.0 | Protocol reference |

---

## 10. Reference Documents

- [Debug Adapter Protocol Specification](https://microsoft.github.io/debug-adapter-protocol/specification)
- [Samsung/netcoredbg — GitHub](https://github.com/Samsung/netcoredbg)
- [netcoredbg Feature Wiki](https://github.com/Samsung/netcoredbg/wiki/Features)
- [ClrDebug — Managed ICorDebug Wrappers](https://github.com/lordmilko/ClrDebug)
- [ICorDebug Interface — Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/unmanaged-api/debugging/icordebug/icordebug-interface)
- [.NET Hot Reload — MetadataUpdater](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.metadata.metadataupdater)
- [dotnet/diagnostics — GitHub](https://github.com/dotnet/diagnostics)
- [EventPipe Overview](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/eventpipe)
- [Microsoft.Diagnostics.NETCore.Client](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/diagnostics-client-library)
- [FORGE-SPEC.md](./FORGE-SPEC.md) — parent specification
- [PROFILER-SPEC.md](./PROFILER-SPEC.md) — performance profiling specification
