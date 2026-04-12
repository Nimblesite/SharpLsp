# DEBUGGING-SPEC

**Forge Debugging Technical Specification**

*March 2026 | DRAFT*

---

## 1. Mission

Forge must deliver a top-tier .NET debugging experience that is fully open-source, editor-agnostic, and license-free. Microsoft's proprietary `vsdbg` is explicitly forbidden by its license from use in any editor except Visual Studio, Visual Studio Code (Microsoft-signed binary), and Visual Studio for Mac. Forge must match or exceed the vsdbg experience using only open-source infrastructure.

The benchmark is brutal: a developer coming from `vsdbg` must not feel degraded. Every mainstream debugging workflow must work. Gaps in open-source tooling that cannot be closed by configuration must be closed by engineering.

C# and F# are treated as equal first-class citizens. F# debugging is not an afterthought.

---

## 2. Debugger Adapter Selection

### 2.1 The Landscape

| Debugger | License | Language | Production-Ready | Notable Gaps |
|---|---|---|---|---|
| **vsdbg** (Microsoft) | **Proprietary — FORBIDDEN** | C++ | Yes | License bars non-VS-Code products |
| **netcoredbg** (Samsung) | MIT | C++ over ICorDebug | Mostly (see §2.3) | Expression eval, async stacks, logpoints, DebuggerDisplay, EnC on Linux/macOS |
| **SharpDbg** (MattParkerDev) | MIT | C# over ClrDebug | Preview (0.1.0-preview5) | Lambda stepping incomplete; Source Link absent; pre-production |
| **Mono SDB** | MIT | Mono | Yes (Mono only) | Incompatible with CoreCLR; not applicable |
| **Rider debugger** (JetBrains) | Proprietary | Java + .NET | Yes | Not redistributable; IntelliJ-coupled |

**Decision: netcoredbg is the primary debugger for Phase 4, with a parallel investment in a Forge-native C# Debug Sidecar (Tier 4) targeting full vsdbg parity in Phase 5.**

### 2.2 Why netcoredbg

- Only MIT-licensed CoreCLR debugger with production DAP support
- Implements the full DAP protocol (v1.71.0) over stdin/stdout — drop-in compatible with any editor
- Used in production by VSCodium, Neovim, Helix, Emacs, and MonoDevelop communities
- Actively maintained by Samsung's Linux Platform team (latest: 3.1.3-1062, December 2025)
- Covers all P1 debugging scenarios: line/conditional/function/exception breakpoints, step in/over/out, variable inspection, call stack navigation
- Supports Linux (x64, ARM64, ARM, RISCV64), Windows (x64, x86, ARM64), macOS (x64, ARM64 community builds)
- Three protocol frontends: CLI, GDB/MI, VSCode DAP — all sharing the same `ManagedDebugger` core
- Supports mixed-mode (managed + native interop) debugging on Linux x64/ARM64

### 2.3 netcoredbg Known Gaps and Open Issues

netcoredbg has real, material gaps versus vsdbg. These are not cosmetic.

**Confirmed missing features:**

| Gap | Impact | Upstream Issue |
|---|---|---|
| `[DebuggerDisplay]` attribute not rendered | Variables panel shows raw object fields, not user-friendly display | SharpDbg comparison confirms absent |
| `[DebuggerTypeProxy]` not supported | Custom collection expansion (e.g., `Dictionary<K,V>`) broken | SharpDbg comparison confirms absent |
| `[DebuggerBrowsable]` not supported | All members displayed regardless of browse attribute | SharpDbg comparison confirms absent |
| No logical async call stack reconstruction | Physical stack only; `MoveNext` frames instead of logical `await` chain | Community pain point |
| Expression evaluator incomplete (LINQ, complex lambdas fail) | Watch window workflows break on real enterprise code | Long-standing limitation |
| No logpoints (tracepoints) | Cannot inject trace messages without pausing execution | No upstream issue tracked |
| No data breakpoints | Cannot break on field/property value changes | Not in roadmap |
| Edit and Continue: Linux/macOS not supported | .NET 8+ runtime supports EnC on Linux/macOS; no open-source client generates deltas | Issue #214 (open) |
| No return value display | Cannot inspect method return values on step-over | Not documented upstream |
| Attach to process: unreliable | `0x80070057` error; intermittent attach failures | Issue #205 |
| macOS ARM64: no official binaries | Requires building from source; no Samsung CI | No upstream commitment |
| musl/Alpine: SIGSEGV on startup | CoreCLR `EnsureStackSize` check overruns musl's fixed 1.5MB thread stack | Issue #201, dotnet/runtime#103741 |
| No parallel stacks data | Multi-threaded debugging crippled — can't visualize all thread stacks at once | Not documented |
| C# 12 primary constructor params not inspectable | Compiler-generated fields not mapped back to source syntax | Issue #203 |
| `Nullable<T>` expansion broken | `Nullable<Guid>` and similar value types cannot be expanded in debugger | Issue #213 |
| Version 3.1.3 stability regression | Crashes on every run in some configurations | Issue #217, #206 |

### 2.4 Why Not Stop at netcoredbg

The Forge answer is a **two-phase approach**:

1. **Phase 4**: Ship netcoredbg integration, closing the most impactful gaps via DapRouter-layer workarounds and upstream contributions
2. **Phase 5**: Ship the Forge Debug Sidecar — a C# Tier 4 process built on `ClrDebug` + `ICorDebug` that achieves full vsdbg feature parity

### 2.5 SharpDbg — Watch and Contribute

SharpDbg (MattParkerDev, MIT, C#) is the most promising long-term foundation for community .NET debugging. It already implements `[DebuggerDisplay]`, `[DebuggerTypeProxy]`, and `[DebuggerBrowsable]` — all absent in netcoredbg. It uses ClrDebug, the same foundation as the planned Forge Debug Sidecar.

**Forge's relationship with SharpDbg:**
- Monitor SharpDbg for production readiness; evaluate as a Phase 5 foundation vs. building from scratch
- Contribute upstream: any ICorDebug wrapper gaps discovered during Forge Debug Sidecar work
- Do not fork SharpDbg; if it reaches production maturity before Phase 5, adopt rather than reinvent

---

## 3. Architecture

### 3.1 System Topology

```
┌────────────────────────────────────────────────────────────────────┐
│  Editor (VS Code, Neovim, Helix, Zed, Emacs, …)                   │
│  DAP JSON-RPC over stdio/socket                                    │
└───────────────────────────┬────────────────────────────────────────┘
                            │ DAP 1.71.0 (JSON-RPC)
                            ▼
┌────────────────────────────────────────────────────────────────────┐
│  Tier 1: Rust LSP/DAP Host (forge)                                │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  DapRouter                                                   │ │
│  │  - Proxies DAP to active debug adapter                       │ │
│  │  - Augments: logpoints, async stacks, DebuggerDisplay        │ │
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

- **Adapter lifecycle**: spawning/monitoring netcoredbg (Phase 4) or the Debug Sidecar (Phase 5), auto-restart on crash with exponential backoff
- **DAP proxy**: forwarding DAP messages between the editor and the active adapter with minimal latency overhead
- **Capability augmentation**: intercepts DAP `initialize` responses to advertise capabilities the underlying adapter lacks but Forge implements at the proxy layer (logpoints, async stack enrichment, DebuggerDisplay)
- **Logpoint emulation**: translates DAP `setBreakpoints` logpoint requests into conditional breakpoints that evaluate + log + continue (Phase 4)
- **Async stack enrichment**: post-processes `stackTrace` responses by reconstructing logical async frames using state-machine field analysis via the C# sidecar (Roslyn)
- **DebuggerDisplay emulation**: in Phase 4, queries the C# sidecar to evaluate `[DebuggerDisplay]` format strings and rewrites `variables` responses with user-friendly display values
- **Multi-session management**: maintains a registry of active debug sessions for multi-process/multi-project scenarios
- **Hot Reload coordination**: integrates with `dotnet watch` / `MetadataUpdater.ApplyUpdate` for hot reload during debug sessions

### 3.3 netcoredbg Integration (Phase 4)

netcoredbg is managed as an external subprocess:

- **Distribution**: bundled with Forge release artifacts (platform-specific binary), or auto-downloaded on first debug launch if not present (with SHA-256 hash verification)
- **Version pinning**: Forge pins a specific netcoredbg release (currently 3.1.3-1062) and upgrades on a tested cadence
- **Transport**: DAP over stdin/stdout; DapRouter opens the child process and pipes JSON-RPC
- **Launch modes**:
  - `launch`: spawn a new .NET process
  - `attach`: attach to an existing PID (known reliability issues — see §6.3)
- **Platform matrix**:

| Platform | Source | Notes |
|---|---|---|
| Linux x64 | Official Samsung release binary | Full feature set including interop debugging |
| Linux ARM64 | Official Samsung release binary | Full feature set |
| macOS x64 | Official Samsung release binary | No interop/native debugging |
| macOS ARM64 | Forge CI build from source | Samsung does not ship official ARM64 macOS binaries |
| Windows x64 | Official Samsung release binary | Full feature set |
| Windows ARM64 | Official Samsung release binary | Full feature set |
| Alpine/musl x64 | Forge CI musl-linked build | Workaround for SIGSEGV on musl — see §6.5 |
| Alpine/musl ARM64 | Forge CI musl-linked build | Same musl workaround |

### 3.4 Forge Debug Sidecar (Phase 5)

A new C# process (Tier 4) that implements the full ICorDebug-based debugger natively:

- **Language**: C# 13 on .NET 9+, matching the existing sidecar architecture
- **Core dependency**: [`ClrDebug`](https://github.com/lordmilko/ClrDebug) v0.3.4+ — managed type-safe P/Invoke wrappers for every ICorDebug COM interface (MIT). On .NET 8+, uses source-generated COM interop for zero-overhead marshaling.
- **Bootstrap**: `Microsoft.Diagnostics.DbgShim` NuGet package (v9.0.661903+, MIT) for runtime discovery and ICorDebug bootstrapping
- **Protocol**: DAP over stdin/stdout (same as netcoredbg, fully drop-in from the DapRouter's perspective)
- **IPC with Rust host**: MessagePack over Unix socket / named pipe for side-channel requests (async stack analysis, expression compilation via Roslyn, DebuggerDisplay/TypeProxy evaluation)
- **Expression evaluation**: delegates expression compilation to the C# sidecar (Tier 2, Roslyn ScriptingWorkspace); receives compiled IL; evaluates via `ICorDebugEval`. Same approach as vsdbg.
- **Async stack reconstruction**: reads state-machine fields from heap objects via `ICorDebugValue` traversal; reconstructs the logical async continuation chain
- **DebuggerDisplay/TypeProxy**: first-class support; evaluates attribute format strings in the debuggee context and returns formatted display values

---

## 4. DAP Protocol

Forge targets **DAP specification version 1.71.0**.

### 4.1 Key Capabilities Used

| Capability | Phase 4 | Phase 5 | Notes |
|---|---|---|---|
| `supportsConditionalBreakpoints` | Yes | Yes | C# expression condition |
| `supportsHitConditionalBreakpoints` | Yes | Yes | `>`, `>=`, `==`, `%` operators |
| `supportsLogPoints` | Yes (emulated) | Yes (native) | Phase 4: conditional bp + continue |
| `supportsEvaluateForHovers` | Yes | Yes | Expression evaluation in hover |
| `supportsSetVariable` | Yes | Yes | Modify variable values at breakpoint |
| `supportsRestartFrame` | No | Yes | Phase 5: `ICorDebugILFrame::SetIP` |
| `supportsStepBack` | No | No | P3 — post Phase 5; requires runtime support |
| `supportsExceptionOptions` | Yes | Yes | Filter by type, user code, etc. |
| `supportsDataBreakpoints` | No | Yes | Phase 5: field value polling / hardware watchpoints |
| `supportsReadMemoryRequest` | No | Yes | Phase 5: raw memory inspection |
| `supportsWriteMemoryRequest` | No | Yes | Phase 5: raw memory write |
| `supportsDisassembleRequest` | Partial | Yes | Phase 5: `ICorDebugCode::GetCode` → IL |
| `supportsTerminateRequest` | Yes | Yes | |
| `supportsRestartRequest` | Yes | Yes | |
| `supportsSingleThreadExecutionRequests` | No | Yes | Phase 5 |
| `supportsInstructionBreakpoints` | No | Yes | Phase 5: IL offset breakpoints |
| `supportsCompletionsRequest` | No | Yes | Phase 5: via Roslyn C# sidecar |
| `supportsVariableType` | Yes | Yes | |
| `supportsANSIStyling` | Yes | Yes | DAP 1.69+ terminal color output |
| `supportsGotoTargetsRequest` | Yes | Yes | Run to cursor via `goto` |
| `supportsLocationReference` | No | Yes | DAP 1.68+ location navigation |

---

## 5. Feature Specification

### 5.1 Launch and Attach

| Feature | DAP Method | Priority | Notes |
|---|---|---|---|
| Launch .NET app (console, web, etc.) | `launch` | P1 | Pass args, env, cwd, program |
| Attach to running process by PID | `attach` | P1 | Known reliability issues in netcoredbg; fixed in Debug Sidecar |
| Attach to running process by name | `attach` (processName) | P2 | Forge resolves name → PID |
| Remote attach via SSH tunnel | `attach` (remote) | P2 | Forge manages SSH tunnel transparently |
| Launch with environment variables | `launch` (env) | P1 | |
| Launch with custom working directory | `launch` (cwd) | P1 | |
| Launch browser for Blazor WASM | `launch` (browser) | P3 | Requires browser devtools bridge |
| Hot Reload enabled launch | `launch` (hotReload: true) | P2 | See §5.9 |
| Child process auto-attach | `launch` event | P2 | Phase 5: `ICorDebugManagedCallback::CreateProcess` |

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

**Attach configuration schema:**

```json
{
  "type": "forge",
  "request": "attach",
  "processId": "${command:pickProcess}",
  "justMyCode": true
}
```

### 5.2 Breakpoints

| Feature | DAP Method | Priority | Implementation |
|---|---|---|---|
| Line breakpoints | `setBreakpoints` | P1 | Native netcoredbg / Debug Sidecar `ICorDebugCode::CreateBreakpoint` |
| Function/method breakpoints | `setFunctionBreakpoints` | P1 | Native |
| Exception breakpoints (all / unhandled) | `setExceptionBreakpoints` | P1 | Native |
| Conditional breakpoints (C# expression) | `setBreakpoints` (condition) | P1 | netcoredbg T1/T2 expressions; Phase 5: full Roslyn eval |
| Hit-count breakpoints | `setBreakpoints` (hitCondition) | P1 | Native |
| Logpoints (tracepoints) | `setBreakpoints` (logMessage) | P1 | Emulated at DapRouter layer in Phase 4; native in Phase 5 |
| Data breakpoints (field value change) | `setDataBreakpoints` | P2 | Phase 5 only (Debug Sidecar) |
| Instruction breakpoints (IL offset) | `setInstructionBreakpoints` | P3 | Phase 5 only |

**Logpoint emulation (Phase 4):**

netcoredbg does not support logpoints natively. DapRouter intercepts `setBreakpoints` requests containing `logMessage`, rewrites them as conditional breakpoints with an expression that:
1. Evaluates the interpolated log string (referencing frame-local variables)
2. Calls `System.Diagnostics.Debug.WriteLine(msg)` to emit the output
3. Returns `false` so execution is never paused

Output is captured from the debug output channel and surfaced as a DAP `output` event. This is transparent to the editor.

### 5.3 Stepping

| Feature | DAP Method | Priority |
|---|---|---|
| Step over | `next` | P1 |
| Step into | `stepIn` | P1 |
| Step out | `stepOut` | P1 |
| Step back (reverse) | `stepBack` | P3 — post Phase 5; requires runtime support |
| Restart frame | `restartFrame` | P2 — Phase 5 |
| Run to cursor (temporary breakpoint) | `goto` | P2 |
| Just My Code (skip non-user code) | launch config | P1 |
| Smart Step Into (F# pipelines) | `stepIn` (targetId) | P2 — Phase 5 |

**Just My Code implementation**: netcoredbg supports `justMyCode: true` in launch config. The Debug Sidecar implements full JMC by checking `[DebuggerNonUserCode]`, `[DebuggerHidden]`, and `[GeneratedCode]` attributes on methods/types, matching vsdbg behavior.

**Smart Step Into (F# Phase 5)**: When a single source line in F# calls multiple functions (pipeline operators, function composition), Smart Step Into presents a list of step targets via the DAP `stepIn` `targetId` mechanism. This requires FCS-provided source location analysis to identify callsites on the current line.

### 5.4 Call Stack

| Feature | DAP Method | Priority | Notes |
|---|---|---|---|
| Call stack display | `stackTrace` | P1 | Physical frames |
| Logical async call stack | `stackTrace` (enriched) | P1 | DapRouter + Roslyn reconstruction (§5.4.1) |
| Navigate to source from frame | `source` | P1 | |
| Load symbols on demand | — | P2 | PDB loading, symbol server |
| Decompiled source navigation | — | P2 | ICSharpCode.Decompiler in C# sidecar |
| Parallel Stacks data | custom `forge/parallelStacks` | P2 | Phase 5: enumerate all thread stacks |

#### 5.4.1 Async Call Stack Reconstruction

This is the most impactful gap in netcoredbg. When code is paused inside an async state machine, the physical call stack only shows the `MoveNext` frame — not the logical chain of `await` continuations.

**Reconstruction algorithm (implemented in C# sidecar, called by DapRouter):**

1. DapRouter receives a `stopped` event from netcoredbg
2. DapRouter requests `stackTrace` from netcoredbg; identifies frames where the type name matches the compiler-generated state machine pattern (`<MethodName>d__N`)
3. For each such frame, DapRouter sends a side-channel request to the C# sidecar with the type name and the `this` object address (extracted from frame locals)
4. C# sidecar uses Roslyn's compilation model to resolve the state machine type; reads `<>1__state`, `<>4__this` (captured instance), and continuation fields from heap via `ICorDebugObjectValue::GetFieldValue`
5. C# sidecar walks the continuation chain by reading `_continuation`/`MoveNextRunner` from the `AsyncTaskMethodBuilder._builder` field to find the next logical frame
6. Reconstructed logical frames are injected into the `stackTrace` response before forwarding to the editor

This reconstruction is best-effort: degrades gracefully (shows physical stack unchanged) when compiler-generated fields cannot be resolved.

**Phase 5 improvement**: Debug Sidecar reads continuation chains directly via `ICorDebugProcess::ReadMemory` without requiring a Roslyn compilation model, making reconstruction faster and more reliable.

#### 5.4.2 F# Async Stack Reconstruction

F# `async { }` computation expressions and `task { }` resumable state machines require separate handling.

**F# PDB limitations** (confirmed gaps in F# compiler, tracked in dotnet/fsharp):
- `StateMachineMethod` table not emitted — debugger cannot map `MoveNext` frames to source without extra heuristics (dotnet/fsharp#12000)
- `StateMachineHoistedLocalScopes` table not emitted — hoisted local variable scopes unavailable

**Forge approach:**
- `task { }` (resumable state machines, F# 6+): use same async stack reconstruction as C# with type name pattern matching adjusted for F# compiler-generated names
- `async { }` (legacy CPS-based): best-effort reconstruction; degrade gracefully to physical stack where continuation chains cannot be followed
- Phase 5: contribute `StateMachineMethod` PDB table emission to dotnet/fsharp, or implement workaround via FCS symbol analysis

### 5.5 Variables and Inspection

| Feature | DAP Method | Priority |
|---|---|---|
| Local variables | `variables` | P1 |
| Function arguments | `variables` | P1 |
| `this` / instance members | `variables` | P1 |
| Static fields | `variables` | P1 |
| Collection/array expansion | `variables` (structured) | P1 |
| `[DebuggerDisplay]` attribute rendering | `variables` | P1 |
| `[DebuggerTypeProxy]` expansion | `variables` | P2 |
| `[DebuggerBrowsable]` attribute | `variables` | P2 |
| Modify variable value at runtime | `setVariable` | P1 |
| Hover expression evaluation | `evaluate` (hover) | P1 |
| Watch window evaluation | `evaluate` (watch) | P1 |
| Immediate window / REPL | `evaluate` (repl) | P2 |
| Return value display on step-over | custom scope | P2 — Phase 5 |
| Raw memory view | `readMemory` / `writeMemory` | P3 — Phase 5 |
| F# discriminated union inspection | `variables` | P1 |
| F# record/tuple inspection | `variables` | P1 |

**DebuggerDisplay emulation (Phase 4):**

netcoredbg does not render `[DebuggerDisplay]`. DapRouter intercepts `variables` responses, queries the C# sidecar to evaluate `[DebuggerDisplay]` format strings using Roslyn expression evaluation against the frame context, and replaces the default `toString()` value in the response. This is best-effort; complex format strings may fall back to the raw class name.

**Expression evaluation quality tiers:**

| Tier | Scenario | Phase 4 (netcoredbg) | Phase 5 (Debug Sidecar) |
|---|---|---|---|
| T1 | Simple field/property access | Works | Works |
| T1 | Arithmetic, string concat | Works | Works |
| T1 | Null checks, type casts | Works | Works |
| T2 | Method calls on locals | Works | Works |
| T2 | Extension methods | Partial | Works |
| T3 | LINQ queries on live objects | Fails | Works (Roslyn → ICorDebugEval) |
| T3 | Multi-statement lambdas | Fails | Works |
| T3 | Generic type inference in expressions | Fails | Works |
| T3 | `dynamic` type evaluation | Fails | Partial |

The Debug Sidecar achieves T3 by delegating expression compilation to the C# sidecar (Roslyn `CSharpScriptCompilation`), receiving compiled IL, loading it as an in-memory assembly into the debuggee, and evaluating via `ICorDebugEval`. This is the same approach as vsdbg.

**F# discriminated union inspection (Phase 4):**

F# DUs compile to class hierarchies in IL. Without F# semantic knowledge, debuggers show raw compiler-generated fields (`_tag`, `_value`, etc.). Forge addresses this via:
- Phase 4: DapRouter queries FCS sidecar to decode DU case names from the type's compiled representation, rewriting the variable display name to match F# syntax (e.g., `Some(42)`)
- Phase 5: Debug Sidecar calls FCS sidecar for full DU-aware variable formatting

### 5.6 Exception Handling

| Feature | Priority |
|---|---|
| Break on all CLR exceptions | P1 |
| Break on unhandled exceptions only | P1 |
| Break on specific exception types (include/exclude filter) | P1 |
| Break on exceptions from user code only | P1 |
| Exception info panel (type, message, stack) | P1 |
| Inner exception chain traversal | P2 |
| Exception conditions (break only if message matches) | P2 — Phase 5 |

Configuration via `setExceptionBreakpoints` with `filterOptions` and `exceptionOptions` per the DAP 1.71.0 specification.

### 5.7 Conditional Breakpoints and Logpoints

**Conditional breakpoints:**

- C# expression evaluated in the context of the paused frame
- Phase 4: expression passed verbatim to netcoredbg's built-in evaluator (T1/T2 tier — see §5.5)
- Phase 5: expression compiled by Roslyn (C# sidecar) and evaluated via `ICorDebugEval` — full T3 support including LINQ
- Hit condition: `>`, `>=`, `<`, `<=`, `==`, `%` operators against hit counter

**Logpoints:**

- Interpolated string with `{expression}` placeholders evaluated in frame context
- Phase 4: DapRouter emulation — conditional breakpoint with `always-continue` semantics (see §5.2)
- Phase 5: native implementation — `ICorDebugBreakpoint` + immediate `ICorDebugEval` + `ICorDebugProcess::Continue`, zero pause visible to user

### 5.8 Hot Reload During Debug

Hot Reload allows modifying method bodies at runtime without restarting the debug session. Forge uses `.NET Hot Reload` (`MetadataUpdater.ApplyUpdate`), not legacy Edit and Continue (`ICorDebugModule2::ApplyChanges`). This distinction is critical:

- `MetadataUpdater.ApplyUpdate` is cross-platform (Linux, macOS, Windows) since .NET 6
- Classic EnC via `ICorDebugModule2::ApplyChanges` requires the debugger to generate delta files; no open-source client generates these deltas for Linux/macOS targets (netcoredbg issue #214)
- `MetadataUpdater.ApplyUpdate` and debugger-based EnC **cannot be used simultaneously** (documented limitation); Forge uses Hot Reload exclusively

**Architecture:**

1. Forge VFS monitors document changes during active debug session
2. On save, C# sidecar computes delta: uses Roslyn `WatchHotReloadService` to generate metadata delta + IL delta + PDB delta as binary blobs
3. DapRouter delivers the delta to the target process via DAP `evaluate` injection (Phase 4) or direct `MetadataUpdater.ApplyUpdate` call (Phase 5)
4. The debug session continues without interruption; next method invocation uses new IL
5. Rude edits (unsupported changes) are detected and reported with reason; user prompted to restart

**Supported hot reload edits:**

| Edit Type | Supported |
|---|---|
| Method body change | Yes |
| Add new method to existing type | Yes (.NET 8+) |
| Add new static field | Yes (.NET 8+) |
| Add new class (non-generic) | Yes (.NET 8+) |
| Change method signature | No — requires restart |
| Add/remove generic type parameter | No — requires restart |
| Modify lambda captured variables | No — requires restart |
| Change inheritance hierarchy | No — requires restart |

**Note on classic EnC (out of scope):** The .NET 8+ runtime supports EnC on Linux/macOS (dotnet/runtime#12409 closed Sept 2023). However, generating the delta files requires IDE tooling that no open-source project currently provides for non-Windows targets. If this gap is closed upstream, Forge will adopt it. Until then, Hot Reload is the cross-platform path.

### 5.9 Multi-Process and Multi-Project Debugging

| Feature | Priority |
|---|---|
| Multiple simultaneous debug sessions | P2 |
| Automatic child process attach | P2 |
| Microservices compound launch | P2 |
| Docker container attach | P2 |
| WSL process attach (Windows) | P3 |

**Implementation:** DapRouter maintains a `DebugSessionRegistry` indexed by session ID. Each session owns an independent adapter process. The editor communicates with multiple sessions via session-ID-prefixed DAP messages. Compound launch configs define multiple named configurations that start simultaneously.

### 5.10 Remote Debugging

Forge manages SSH tunnel setup transparently. The debug adapter always runs locally (against a forwarded socket), avoiding the complexity of cross-machine DAP transport.

| Step | Action |
|---|---|
| 1 | Forge SSH's to remote host, uploads netcoredbg or Debug Sidecar binary |
| 2 | Forge starts the adapter on the remote host listening on a local port |
| 3 | Forge creates an SSH local port-forward for that port |
| 4 | DapRouter connects to the local end of the tunnel |
| 5 | Source files are mapped from remote paths to local paths via `sourceFileMap` config |

**Remote attach configuration:**

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

### 5.11 Test Debugging

| Feature | Protocol | Priority |
|---|---|---|
| Debug individual test | DAP + `forge/testDebug` | P1 |
| Debug test with args/env override | DAP + `forge/testDebug` | P2 |
| Breakpoints inside test methods | Standard line breakpoints | P1 |
| Just My Code in test context | launch config | P1 |
| Debug entire test class/suite | DAP + `forge/testDebug` | P2 |
| Expecto/FsCheck test debugging | DAP + `forge/testDebug` | P1 (F# parity) |

**Test host process attach**: `dotnet test` spawns a separate test host process (`testhost.exe`/`dotnet-testhost`). Forge must attach to the child test host, not the parent `dotnet test` process. The `VSTEST_HOST_DEBUG=1` environment variable causes the test host to pause and wait for a debugger attach before executing tests. Forge sets this variable in the test debug launch and attaches to the waiting process.

### 5.12 Diagnostic Tools Integration

Debugging and diagnostics are complementary. Forge integrates the .NET diagnostic tools (all MIT, dotnet/diagnostics v9.0.661903+) alongside the debugger.

| Feature | Tool | DAP Integration | Priority |
|---|---|---|---|
| CPU sampling profiler | `dotnet-trace` (EventPipe) | `forge/profileStart` custom event | P2 |
| Memory allocation profiler | `dotnet-gcdump` + `dotnet-trace` | `forge/heapSnapshot` custom event | P2 |
| GC heap snapshot | `dotnet-gcdump` | `forge/gcDump` custom event | P2 |
| Live counters (CPU, GC, requests/sec) | `dotnet-counters` | `forge/counters` streaming event | P2 |
| Process dump on crash | `dotnet-dump` | Auto-triggered on unhandled exception | P3 |
| Dump analysis | `dotnet-dump analyze` + SOS | `forge/analyzeDump` custom request | P3 |

These are exposed as DAP custom events/notifications, surfaced in the editor as a diagnostics panel alongside the debugger. See `PROFILER-SPEC.md` for full profiler specification.

**Note on musl/Alpine support**: `Microsoft.Diagnostics.NETCore.Client` (the backing library for all diagnostic tools) ships musl/Alpine builds as part of the dotnet/diagnostics release. This is a broader platform support story than netcoredbg. Diagnostic tools work on Alpine even when netcoredbg does not.

---

## 6. F# Debugging: First-Class Status

F# debugging requires dedicated investment beyond what C# infrastructure provides automatically.

### 6.1 F# Compiler PDB Gaps

The F# compiler does not emit the following PDB tables that debuggers rely on:

| Missing Table | Impact | Upstream Issue |
|---|---|---|
| `StateMachineMethod` | Step-into `task {}` requires two Step Into presses; debugger cannot map `MoveNext` to source cleanly | dotnet/fsharp#12000 (open) |
| `StateMachineHoistedLocalScopes` | Hoisted local variables in async/task state machines lack scope info | Tracked alongside above |
| `LocalConstants` | Constant values not in PDB | Minor impact |
| `DynamicLocalVariables` | Dynamic-typed locals lose type info | Minor impact |

**Forge's approach:**
- Phase 4: implement heuristic PDB mapping for F# state machines via FCS sidecar symbol analysis
- Phase 5: contribute `StateMachineMethod` table emission to dotnet/fsharp; until accepted, maintain Forge-local patch or workaround

### 6.2 Computation Expression Stepping

F# `async { }` desugars into CPS (continuation-passing style) library calls. Stepping behavior reflects the desugared form, not the source. This is documented as a known limitation.

`task { }` (resumable state machines since F# 6) behaves significantly better due to inlining and more predictable PDB mapping. Prefer `task {}` over `async {}` in internal Forge test code.

**Smart Step Into (Phase 5)**: Uses DAP `stepIn` with `targetId` to let users choose which function to step into when F# pipelines or function composition calls multiple functions on one line.

### 6.3 Discriminated Union Inspection

DUs compile to class hierarchies. Without F# semantic knowledge, a variable `Some 42` displays as `FSharpOption`1 { Tag = 1, Value = 42 }` instead of `Some(42)`.

Forge addresses this in three layers:
1. **Phase 4 DapRouter**: queries FCS sidecar for DU type metadata; rewrites `variables` response display values to F# syntax
2. **Phase 5 Debug Sidecar**: native DU-aware `variables` formatting via FCS sidecar channel
3. **Longer term**: contribute `[DebuggerDisplay]` attribute emission in F# compiler for DU cases

### 6.4 F# Mailbox Processor Debugging

`MailboxProcessor<'Msg>` actors are a common F# pattern. Forge exposes:
- Current message queue depth as a pseudo-variable in the variables panel (Phase 5)
- Ability to inspect pending messages (Phase 5, best-effort)

### 6.5 F# Expression Evaluation

F# expression evaluation in the watch/immediate window:
- Phase 4: limited to T1/T2 tier (same as C#; F# syntax not supported — user must use compiled IL names)
- Phase 5: route `evaluate` requests to FCS sidecar for F# expression compilation, then evaluate via `ICorDebugEval`

---

## 7. Known Gaps and Closure Strategy

### 7.1 Async Call Stack (Phase 4 partial, Phase 5 complete)

**Gap:** netcoredbg shows physical call stack only.

**Closure:** DapRouter + C# sidecar enrichment (§5.4.1). Phase 4 ships best-effort. Phase 5 ships full reconstruction.

### 7.2 Expression Evaluation (Phase 4 limited, Phase 5 full)

**Gap:** netcoredbg fails on LINQ, complex lambdas.

**Closure:** Phase 5 Roslyn ScriptingWorkspace → ICorDebugEval pipeline.

### 7.3 DebuggerDisplay/TypeProxy (Phase 4 emulated, Phase 5 native)

**Gap:** netcoredbg does not render `[DebuggerDisplay]`, `[DebuggerTypeProxy]`, or `[DebuggerBrowsable]`.

**Closure:** Phase 4 DapRouter emulation via C# sidecar evaluation. Phase 5 Debug Sidecar implements natively (same as SharpDbg).

### 7.4 Process Attach Reliability (Phase 4 improved, Phase 5 fixed)

**Gap:** netcoredbg `attach` mode returns `0x80070057` error (issue #205).

**Closure:** Forge contributes fix upstream. DapRouter implements retry with exponential backoff. Phase 5 Debug Sidecar uses `DbgShim.RegisterForRuntimeStartup` for reliable race-free attach.

### 7.5 macOS ARM64 (Phase 4 fixed, Phase 5 native)

**Gap:** Samsung does not ship macOS ARM64 binaries for netcoredbg.

**Closure:** Forge CI builds netcoredbg from source for `darwin-arm64`. Phase 5 Debug Sidecar is managed .NET 9 code — no native compilation issues on ARM64.

### 7.6 musl/Alpine (Phase 4 worked around, Phase 5 native)

**Gap:** netcoredbg SIGSEGV on musl due to CoreCLR `EnsureStackSize` overrunning musl's fixed 1.5MB thread stack (dotnet/runtime#103741). This is a CoreCLR bug, not a netcoredbg bug.

**Closure:** Forge CI maintains a musl-linked netcoredbg build with patched stack size pre-reservation. Contribute fix to dotnet/runtime. Phase 5 Debug Sidecar runs as managed code; the musl issue affects the C++ ICorDebug shim layer, which ClrDebug wraps but does not eliminate. Monitor dotnet/runtime#103741 for upstream fix.

### 7.7 Logpoints (Phase 4 emulated, Phase 5 native)

**Gap:** netcoredbg has no logpoint support.

**Closure:** DapRouter emulation ships in Phase 4. Phase 5 implements native zero-pause logpoints.

### 7.8 Edit and Continue (cross-platform, Phase 5+)

**Gap:** .NET 8+ runtime supports EnC on Linux/macOS, but no open-source client generates delta files for these platforms.

**Closure:** Forge uses Hot Reload (`MetadataUpdater.ApplyUpdate`) which is fully cross-platform. Classic EnC is explicitly out of scope until an upstream open-source delta generator exists. Forge will adopt immediately if/when that gap closes.

### 7.9 Return Value Display (Phase 5)

**Gap:** netcoredbg does not show method return values on step-over.

**Closure:** Phase 5 Debug Sidecar captures return values via `ICorDebugILFrame::GetReturnValueForILOffset` and synthesizes a `returnValue` pseudo-variable in the `variables` response under a dedicated `Return Value` scope (per DAP 1.67+ `returnValue` presentation hint).

### 7.10 Data Breakpoints (Phase 5)

**Gap:** netcoredbg does not support data breakpoints.

**Closure:** Phase 5 Debug Sidecar implements via field value polling on `StepComplete` events or hardware watchpoints via platform-specific APIs where available.

### 7.11 F# PDB Tables (Phase 4 heuristic, Phase 5 contribution)

**Gap:** F# compiler does not emit `StateMachineMethod` or `StateMachineHoistedLocalScopes` PDB tables.

**Closure:** Phase 4 uses FCS sidecar heuristics. Phase 5 contributes PDB table emission to dotnet/fsharp; maintains fallback heuristics indefinitely.

---

## 8. Security Considerations

- The debug adapter runs as the same user as the target process; Forge does not elevate privileges
- Remote debugging SSH keys are user-managed; Forge does not store credentials
- Process attach is guarded by OS-level ptrace permissions (Linux) and entitlement checks (macOS)
- Forge does not accept debug adapter connections from network interfaces (local sockets only)
- `dotnet-dump` output may contain sensitive heap data; Forge stores dumps in user-specified paths only
- `ICorDebugEval` expression evaluation executes arbitrary code in the debuggee — scope is limited to the current debug session; no cross-session execution

---

## 9. Performance Targets

| Metric | Target |
|---|---|
| Time from F5 to first breakpoint hit (cold) | <5s |
| Time from F5 to first breakpoint hit (warm) | <2s |
| Step latency (step over / step in / step out) | <200ms p95 |
| Variable panel population after stop | <300ms p95 |
| Conditional breakpoint expression evaluation | <100ms per evaluation |
| Logpoint output latency (Phase 4 emulated) | <200ms |
| Logpoint output latency (Phase 5 native) | <50ms |
| Hot Reload apply latency | <1s from save |
| Async stack reconstruction latency | <150ms |
| Attach to running process | <3s |
| DapRouter proxy overhead (added latency) | <5ms per message |

---

## 10. Dependencies

| Dependency | Version | License | Use |
|---|---|---|---|
| [netcoredbg](https://github.com/Samsung/netcoredbg) | 3.1.3-1062+ | MIT | Phase 4 debug adapter |
| [ClrDebug](https://github.com/lordmilko/ClrDebug) | 0.3.4+ | MIT | Phase 5 managed ICorDebug wrapper |
| [Microsoft.Diagnostics.DbgShim](https://www.nuget.org/packages/Microsoft.Diagnostics.DbgShim) | 9.0.661903+ | MIT | DbgShim for runtime discovery |
| [Microsoft.Diagnostics.NETCore.Client](https://www.nuget.org/packages/Microsoft.Diagnostics.NETCore.Client) | 9.0.661903+ | MIT | EventPipe / diagnostics IPC |
| [Microsoft.CodeAnalysis.CSharp.Scripting](https://www.nuget.org/packages/Microsoft.CodeAnalysis.CSharp.Scripting) | 5.3.0+ | MIT | Expression compilation for C# eval |
| [FSharp.Compiler.Service](https://www.nuget.org/packages/FSharp.Compiler.Service) | 43.12+ | MIT | F# expression compilation + DU analysis |
| DAP specification | 1.71.0 | CC-BY 4.0 | Protocol reference |

---

## 11. Reference Documents

- [Debug Adapter Protocol Specification 1.71.0](https://microsoft.github.io/debug-adapter-protocol/specification)
- [DAP Changelog](https://microsoft.github.io/debug-adapter-protocol/changelog.html)
- [Samsung/netcoredbg — GitHub](https://github.com/Samsung/netcoredbg)
- [netcoredbg Features Wiki](https://github.com/Samsung/netcoredbg/wiki/Features)
- [netcoredbg Issue Tracker](https://github.com/Samsung/netcoredbg/issues)
- [ClrDebug — Managed ICorDebug Wrappers](https://github.com/lordmilko/ClrDebug)
- [SharpDbg — C# DAP Debugger](https://github.com/MattParkerDev/sharpdbg)
- [ICorDebug Interface — Microsoft Learn](https://learn.microsoft.com/en-us/dotnet/core/unmanaged-api/debugging/icordebug/icordebug-interface)
- [Microsoft.Diagnostics.DbgShim NuGet](https://www.nuget.org/packages/Microsoft.Diagnostics.DbgShim/)
- [.NET Hot Reload — MetadataUpdater](https://learn.microsoft.com/en-us/dotnet/api/system.reflection.metadata.metadataupdater)
- [dotnet/diagnostics — GitHub](https://github.com/dotnet/diagnostics)
- [Microsoft.Diagnostics.NETCore.Client docs](https://learn.microsoft.com/en-us/dotnet/core/diagnostics/microsoft-diagnostics-netcore-client)
- [F# Debug Emit Guide](https://fsharp.github.io/fsharp-compiler-docs/debug-emit.html)
- [dotnet/fsharp#12000 — StateMachineMethod PDB table](https://github.com/dotnet/fsharp/issues/12000)
- [dotnet/runtime#103741 — musl SIGSEGV in netcoredbg](https://github.com/dotnet/runtime/issues/103741)
- [dotnet/runtime#12409 — Linux EnC support (closed)](https://github.com/dotnet/runtime/issues/12409)
- [Samsung/netcoredbg#214 — Cross-platform EnC](https://github.com/Samsung/netcoredbg/issues/214)
- [Samsung/netcoredbg#201 — musl SIGSEGV](https://github.com/Samsung/netcoredbg/issues/201)
- [FORGE-SPEC.md](./FORGE-SPEC.md) — parent specification
- [PROFILER-SPEC.md](./PROFILER-SPEC.md) — performance profiling specification
