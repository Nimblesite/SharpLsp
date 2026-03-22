# DEBUGGING-PLAN

**Forge Debugging Implementation Plan**

*March 2026 | DRAFT*

Spec: [DEBUGGING-SPEC.md](../specs/DEBUGGING-SPEC.md)

---

## Phase 4 — netcoredbg Integration (Months 15–17)

Goal: Ship a functional, production-quality debugging experience for all editors using netcoredbg as the underlying adapter. Close the most impactful gaps via DapRouter-layer workarounds.

### 4.1 Infrastructure

- [ ] Add `DapRouter` module to the Rust host (`crates/dap/`)
- [ ] Implement DAP JSON-RPC framing (Content-Length header, UTF-8 body) in Rust
- [ ] Implement DAP proxy: bidirectional message forwarding between editor socket and adapter subprocess
- [ ] Implement adapter subprocess lifecycle: spawn, stdout/stderr capture, crash detection, restart
- [ ] Add DAP session registry to `DapRouter` (keyed by session ID)
- [ ] Wire DAP listen socket into the LSP host's tokio runtime (separate port or stdio multiplexed)
- [ ] Add `forge/debugAdapterInfo` LSP extension to report active adapter version and capabilities

### 4.2 netcoredbg Bundling and Distribution

- [ ] Add netcoredbg to CI release pipeline: download prebuilt binaries for each platform target
- [ ] Platform targets: `linux-x64`, `linux-arm64`, `win-x64`, `osx-x64`
- [ ] Add Forge CI job: build netcoredbg from source for `osx-arm64` (Apple Silicon)
- [ ] Add Forge CI job: build netcoredbg for Alpine/musl (`linux-musl-x64`, `linux-musl-arm64`)
- [ ] Version-pin netcoredbg in `Cargo.toml` metadata / CI config alongside other dependencies
- [ ] Implement first-run auto-download if bundled binary is absent (with hash verification)
- [ ] Add `forge/debugAdapterStatus` notification for download progress

### 4.3 Launch and Attach

- [ ] Implement `launch` request handler: build netcoredbg argv from Forge launch config
- [ ] Implement `attach` request handler: PID-based attach
- [ ] Implement attach-by-process-name: resolve name → PID via `/proc` (Linux) / `ps` (macOS) / `Process.GetProcessesByName` (.NET)
- [ ] Implement `sourceFileMap` path remapping in `stackTrace` responses
- [ ] Support `stopAtEntry: true` — set a breakpoint on `Main` before continuing
- [ ] Support `console: integratedTerminal` — launch process in editor's terminal
- [ ] Implement `justMyCode` launch flag forwarding to netcoredbg
- [ ] Add `requireExactSource` support
- [ ] E2E test: launch console app, hit breakpoint, inspect variable, step, continue, terminate
- [ ] E2E test: launch ASP.NET app, hit breakpoint on request handler
- [ ] E2E test: attach to running `dotnet run` process

### 4.4 Breakpoints

- [ ] Implement `setBreakpoints` proxy with response normalization
- [ ] Implement `setFunctionBreakpoints` proxy
- [ ] Implement `setExceptionBreakpoints` proxy with filter options
- [ ] Implement logpoint emulation in DapRouter:
  - [ ] Detect `logMessage` field in `SourceBreakpoint`
  - [ ] Rewrite as conditional breakpoint: expression = `System.Diagnostics.Debug.WriteLine($"...{expr}..."); false`
  - [ ] Capture output from debugger output channel and surface as DAP `output` event
  - [ ] E2E test: logpoint fires correct message, does not pause execution
- [ ] Implement hit-count breakpoint forwarding (`hitCondition`)
- [ ] E2E test: conditional breakpoint fires on correct iteration
- [ ] E2E test: exception breakpoint catches first-chance exception
- [ ] E2E test: function breakpoint hits on named method entry

### 4.5 Stepping

- [ ] Proxy `next`, `stepIn`, `stepOut`, `continue`, `pause`, `reverseContinue` (as no-op for Phase 4)
- [ ] Implement `goto` as temporary breakpoint + continue (run to cursor)
- [ ] E2E test: step over, step into, step out of a method call chain
- [ ] E2E test: Just My Code — step skips framework code

### 4.6 Call Stack and Async Stack Enrichment

- [ ] Proxy `stackTrace` requests to netcoredbg
- [ ] Implement async stack enrichment in DapRouter:
  - [ ] Detect frames with compiler-generated state machine types (`<...>d__N`)
  - [ ] Build side-channel request to C# sidecar with: type name, `this` address, frame index
  - [ ] C# sidecar: implement `ReconstructAsyncStack` request handler using Roslyn type model
  - [ ] C# sidecar: walk state machine fields to extract `<>1__state`, `<>4__this`, continuation chain
  - [ ] DapRouter: inject reconstructed frames into `stackTrace` response
  - [ ] Degrade gracefully when fields cannot be resolved (return physical stack unchanged)
  - [ ] E2E test: paused inside `await Task.Delay`, logical stack shows caller chain
- [ ] Proxy `scopes`, `variables`, `source` requests

### 4.7 Variable Inspection and Evaluation

- [ ] Proxy `variables` requests with structured variable response normalization
- [ ] Proxy `evaluate` requests (hover, watch, repl contexts)
- [ ] Implement `setVariable` proxy
- [ ] Normalize `DebuggerDisplay` attribute rendering in variable names
- [ ] E2E test: inspect `List<T>` — items expanded correctly
- [ ] E2E test: inspect `Dictionary<K,V>` — key-value pairs visible
- [ ] E2E test: modify int variable at runtime, continue — new value used
- [ ] E2E test: hover over variable in editor — tooltip shows value
- [ ] E2E test: watch expression `items.Count` — evaluates correctly

### 4.8 Exception Handling

- [ ] Proxy `setExceptionBreakpoints` with `filterOptions`
- [ ] Implement exception info enrichment: inner exception chain in `variables` response
- [ ] E2E test: break on unhandled `NullReferenceException`, inspect message and stack
- [ ] E2E test: break on first-chance `ArgumentException` from a specific namespace

### 4.9 Hot Reload

- [ ] Implement `forge/hotReload` custom notification handler in DapRouter
- [ ] Integrate with VFS: watch for document saves during active debug session
- [ ] C# sidecar: implement `EmitDiff` via `Compilation.EmitDifference`
- [ ] DapRouter: call `MetadataUpdater.ApplyUpdate` in the target process via DAP `evaluate` injection
- [ ] Surface `forge/hotReloadResult` notification to editor (success / rejected changes list)
- [ ] E2E test: edit method body while paused → continue → new behavior observed without restart
- [ ] E2E test: unsupported edit (signature change) → user sees clear rejection message

### 4.10 Multi-Process Debugging

- [ ] Implement `DebugSessionRegistry` in DapRouter
- [ ] Support multiple concurrent debug sessions with independent adapters
- [ ] Implement compound launch: parse multiple `launch` configs, start all sequentially
- [ ] E2E test: two processes debugged simultaneously, breakpoint in each

### 4.11 Test Debugging Integration

- [ ] Implement `forge/testDebug` handler: build DAP launch config for test host process
- [ ] Wire test discovery project + test filter into `dotnet test` DAP launch
- [ ] E2E test: set breakpoint inside xUnit test method, `forge/testDebug` → breakpoint hit
- [ ] E2E test: set breakpoint inside NUnit test method

### 4.12 Phase 4 Quality Gates

- [ ] All P1 breakpoint types work reliably on Linux x64
- [ ] All P1 breakpoint types work reliably on macOS ARM64 (using Forge-built netcoredbg)
- [ ] All P1 breakpoint types work reliably on Windows x64
- [ ] Logpoint emulation verified on all platforms
- [ ] Async stack enrichment reduces MoveNext frames in 90% of async test cases
- [ ] No crash in DapRouter when netcoredbg crashes (clean recovery, user-visible error)
- [ ] Full E2E test suite passes in CI on all three platforms

---

## Phase 5 — Forge Debug Sidecar (Months 21–26)

Goal: Replace netcoredbg with a C# Tier 4 sidecar that achieves full vsdbg parity. Close all known gaps documented in DEBUGGING-SPEC §6.

### 5.1 Debug Sidecar Bootstrap

- [ ] Create `sidecar/debug/` directory — new C# project (`Forge.Debug.Sidecar`)
- [ ] Add `ClrDebug` NuGet dependency (managed ICorDebug wrappers)
- [ ] Add `Microsoft.Diagnostics.DbgShim` NuGet dependency
- [ ] Add `Microsoft.Diagnostics.NETCore.Client` NuGet dependency
- [ ] Implement DAP stdin/stdout transport (Content-Length framing, JSON-RPC)
- [ ] Implement `initialize` request handler: report full Phase 5 capability set
- [ ] Implement IPC channel to Rust host (MessagePack socket, same protocol as other sidecars)
- [ ] Implement adapter registration: DapRouter auto-selects Debug Sidecar when present

### 5.2 ICorDebug Core

- [ ] Implement `ICorDebugManagedCallback` — all event callbacks:
  - [ ] `Breakpoint`, `StepComplete`, `Break`, `Exception`, `EvalComplete`, `EvalException`
  - [ ] `CreateProcess`, `ExitProcess`, `CreateThread`, `ExitThread`
  - [ ] `LoadModule`, `UnloadModule`, `LoadClass`, `UnloadClass`
  - [ ] `DebuggerError`, `LogMessage`, `LogSwitch`
  - [ ] `CreateAppDomain`, `ExitAppDomain`, `LoadAssembly`, `UnloadAssembly`
  - [ ] `UpdateModuleSymbols`, `EditAndContinueRemap`, `BreakpointSetError`
- [ ] Implement `DbgShim` bootstrap: `RegisterForRuntimeStartup` for launch, `EnumerateCLRs` for attach
- [ ] Implement event dispatch loop with async-safe `ICorDebugController::Continue`
- [ ] Implement thread enumeration and management

### 5.3 Launch and Attach

- [ ] Implement `launch` via `CreateProcess` with debug flag + `ICorDebug::DebugActiveProcess`
- [ ] Implement `attach` via `DbgShim.RegisterForRuntimeStartup` (reliable, zero-race attach)
- [ ] Implement attach-by-name: PID resolution + `attach`
- [ ] Implement child process auto-attach on `CreateProcess` event
- [ ] E2E test: reliable attach to process that is already running (regression test for netcoredbg issue #194 scenario)

### 5.4 Full Breakpoint Implementation

- [ ] Implement line breakpoints via `ICorDebugCode::CreateBreakpoint`
- [ ] Implement function breakpoints via `ICorDebugFunction::CreateBreakpoint`
- [ ] Implement exception breakpoints via `ICorDebugProcess::SetUnhandledException` + first-chance filter
- [ ] Implement conditional breakpoints: full C# expression via Roslyn eval pipeline (§5.6)
- [ ] Implement hit-count breakpoints: counter in `ICorDebugManagedCallback::Breakpoint` handler
- [ ] **Implement native logpoints**: evaluate log expression, output to DAP `output` event, call `Continue` immediately — zero pause
- [ ] **Implement data breakpoints**: field polling on `StepComplete`, or hardware watchpoints via platform-specific APIs
- [ ] **Implement instruction breakpoints** via `ICorDebugCode2::SetIP` at IL offset
- [ ] E2E test: data breakpoint fires when `_count` field changes from 4 to 5

### 5.5 Full Call Stack with Async Reconstruction

- [ ] Implement `stackTrace` via full `ICorDebugThread` → `ICorDebugChain` → `ICorDebugFrame` traversal
- [ ] Implement full async logical stack reconstruction (C# sidecar channel, same as Phase 4 but with direct heap access)
- [ ] Implement parallel stacks: enumerate all threads, build frame graphs, expose as custom `forge/parallelStacks` event
- [ ] **Implement restart frame**: `ICorDebugILFrame::CanSetIP` → `ICorDebugILFrame::SetIP` to first IL offset
- [ ] E2E test: 5-level async chain — logical stack shows all 5 caller frames

### 5.6 Full Expression Evaluation (Roslyn Pipeline)

- [ ] Implement expression compilation pipeline:
  - [ ] Forge Debug Sidecar receives `evaluate` request with expression string + frame context
  - [ ] Sidecar queries Roslyn C# sidecar (IPC) to compile expression in scope context
  - [ ] Roslyn returns compiled IL bytes for an in-memory assembly
  - [ ] Debug Sidecar loads IL assembly into target process via `ICorDebugProcess::ReadMemory`/`WriteMemory`
  - [ ] Debug Sidecar creates `ICorDebugEval`, calls `ICorDebugEval::CallFunction` with compiled method
  - [ ] Debug Sidecar collects `EvalComplete` event and deserializes `ICorDebugValue` result
  - [ ] Result returned as structured DAP `evaluate` response
- [ ] E2E test: `myList.Where(x => x > 5).Count()` in watch window returns correct value
- [ ] E2E test: multi-statement expression `var s = items.Sum(); s * 2` evaluates correctly
- [ ] E2E test: LINQ query over `IEnumerable<T>` with 1000 items evaluates in <100ms

### 5.7 Variable Inspection Enhancements

- [ ] Implement `DebuggerTypeProxy` expansion: detect attribute, instantiate proxy type via eval, expand proxy members
- [ ] **Implement return value display**: `ICorDebugILFrame::GetReturnValueForILOffset` after step-over
- [ ] Implement raw memory read/write: `readMemory` / `writeMemory` DAP requests via `ICorDebugProcess`
- [ ] Implement disassembly: `disassemble` request using `ICorDebugCode::GetCode` → IL disassembly
- [ ] Implement completions in evaluate: `completions` DAP request via Roslyn C# sidecar
- [ ] E2E test: `DebuggerTypeProxy` on `Dictionary<K,V>` shows formatted key-value pairs
- [ ] E2E test: return value of `ComputeTotal()` shown after step-over

### 5.8 Hot Reload — Full Implementation

- [ ] Move Hot Reload from DapRouter eval injection to Debug Sidecar direct `MetadataUpdater.ApplyUpdate` call
- [ ] Implement delta caching: avoid re-compiling unchanged methods
- [ ] Implement multi-assembly delta application
- [ ] Implement Rude Edit detection: report unsupported edits with reason
- [ ] E2E test: edit + continue round-trip <1s on a 50-method project

### 5.9 F# Debugging

- [ ] F# source maps: map compiler-generated class names to F# source identifiers
- [ ] F# expression evaluation: route `evaluate` to FCS sidecar for F# expression compilation
- [ ] Discriminated union inspection: pretty-print DU cases in variables panel
- [ ] F# async (`async { }`) logical stack: reconstruct logical continuation chains for F# async workflows
- [ ] F# mailbox processor: show current message queue depth in variables
- [ ] E2E test: debug F# console app, inspect discriminated union value in variables panel
- [ ] E2E test: step through F# pipeline operator chain

### 5.10 Remote Debugging (Full)

- [ ] Implement SSH tunnel management in DapRouter: connect, upload binary, start adapter, forward port
- [ ] Implement `sourceFileMap` path remapping for remote paths
- [ ] Implement remote binary upload with progress reporting
- [ ] E2E test: debug a .NET app running in a Linux Docker container from a macOS host

### 5.11 Phase 5 Quality Gates

- [ ] All DAP capability flags match the Phase 5 capability matrix in DEBUGGING-SPEC §5
- [ ] Expression evaluation: LINQ + lambda tier (T3) passes on all test cases
- [ ] Async logical stack: 100% of async test cases show logical frames (no MoveNext frames)
- [ ] Data breakpoints: field change detection works for reference and value types
- [ ] Logpoints: native implementation, zero latency, verified via timing test (<50ms)
- [ ] Return value display: shows for all non-void method step-overs
- [ ] F# debugging: DU inspection + F# async stack verified
- [ ] Remote debugging: full round-trip E2E test against Docker container
- [ ] No regression on any Phase 4 test cases

---

## Continuous: Upstream Contributions

- [ ] Contribute logpoint native implementation to Samsung/netcoredbg (benefit Phase 4 users of netcoredbg without Forge)
- [ ] Contribute macOS ARM64 CI fixes to Samsung/netcoredbg
- [ ] Contribute musl/Alpine fix to Samsung/netcoredbg
- [ ] Contribute async stack reconstruction to Samsung/netcoredbg (or document algorithm for upstream adoption)
- [ ] File and track attach reliability issue #194 resolution in Samsung/netcoredbg
- [ ] Contribute to ClrDebug: any missing ICorDebug interface wrappers needed by Phase 5 work
