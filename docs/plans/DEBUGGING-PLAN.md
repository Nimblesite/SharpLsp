# DEBUGGING-PLAN

**SharpLsp Debugging Implementation Plan**

*March 2026 | DRAFT*

Spec: [DEBUGGING-SPEC.md](../specs/DEBUGGING-SPEC.md)

---

## Phase 4 — netcoredbg Integration (Months 15–17)

Goal: Ship a production-quality debugging experience for all editors using netcoredbg as the underlying adapter. Close the most impactful gaps via DapRouter-layer workarounds. F# debugging is a P1 deliverable, not a stretch goal.

---

### 4.1 Infrastructure

- [ ] Add `DapRouter` module to the Rust host (`crates/dap/`)
- [ ] Implement DAP JSON-RPC framing (Content-Length header, UTF-8 body) in Rust
- [ ] Implement DAP proxy: bidirectional message forwarding between editor socket and adapter subprocess
- [ ] Implement adapter subprocess lifecycle: spawn, stdout/stderr capture, crash detection, restart with exponential backoff
- [ ] Add DAP session registry to `DapRouter` (keyed by session ID)
- [ ] Wire DAP listen socket into the LSP host's tokio runtime (separate port or stdio multiplexed)
- [ ] Add `sharplsp/debugAdapterInfo` LSP extension to report active adapter version and capabilities
- [ ] Intercept `initialize` response: augment capability flags for SharpLsp-emulated features (logpoints, DebuggerDisplay, async stacks)

### 4.2 netcoredbg Bundling and Distribution

- [ ] Add netcoredbg to CI release pipeline for all platform targets
- [ ] Platform targets: `linux-x64`, `linux-arm64`, `win-x64`, `win-arm64`, `osx-x64`
- [ ] Add SharpLsp CI job: build netcoredbg from source for `osx-arm64` (Apple Silicon — Samsung does not ship official ARM64 macOS binaries)
- [ ] Add SharpLsp CI job: build netcoredbg for Alpine/musl (`linux-musl-x64`, `linux-musl-arm64`) with patched stack size pre-reservation to work around dotnet/runtime#103741
- [ ] Version-pin netcoredbg `3.1.3-1062` in CI config; document upgrade cadence and testing requirement
- [ ] Implement first-run auto-download if bundled binary absent (SHA-256 hash verification mandatory)
- [ ] Add `sharplsp/debugAdapterStatus` notification for download progress display

### 4.3 Launch and Attach

- [ ] Implement `launch` request handler: construct netcoredbg argv from SharpLsp launch config schema
- [ ] Implement `attach` request handler: PID-based attach with retry on `0x80070057` (issue #205 workaround — 3 retries, 500ms backoff)
- [ ] Implement attach-by-process-name: resolve name → PID via `/proc` (Linux) / `sysctl`+`ps` (macOS) / `Process.GetProcessesByName` (.NET helper in C# sidecar)
- [ ] Implement `sourceFileMap` path remapping in `stackTrace` responses
- [ ] Support `stopAtEntry: true` — set a temporary breakpoint on `Main` / program entry before continuing
- [ ] Support `console: integratedTerminal` — launch process in editor's integrated terminal
- [ ] Implement `justMyCode` launch flag forwarding to netcoredbg
- [ ] Add `requireExactSource` support
- [ ] E2E test: launch console app, hit breakpoint, inspect variable, step, continue, terminate (Linux x64)
- [ ] E2E test: launch console app on macOS ARM64 (SharpLsp-built netcoredbg)
- [ ] E2E test: launch ASP.NET app, hit breakpoint on request handler
- [ ] E2E test: attach to running `dotnet run` process by PID
- [ ] E2E test: attach by process name resolves to correct PID

### 4.4 Breakpoints

- [ ] Implement `setBreakpoints` proxy with response normalization
- [ ] Implement `setFunctionBreakpoints` proxy
- [ ] Implement `setExceptionBreakpoints` proxy with `filterOptions` and `exceptionOptions`
- [ ] Implement hit-count breakpoint forwarding (`hitCondition` with `>`, `>=`, `==`, `%` operators)
- [ ] Implement logpoint emulation in DapRouter:
  - [ ] Detect `logMessage` field in `SourceBreakpoint`
  - [ ] Rewrite as conditional breakpoint: `System.Diagnostics.Debug.WriteLine($"[SharpLsp logpoint] {interpolated_msg}"); false`
  - [ ] Capture debug output channel; surface as DAP `output` event with `category: "stdout"`
  - [ ] E2E test: logpoint fires correct message and does not pause execution
  - [ ] E2E test: logpoint with `{expression}` placeholder evaluates expression correctly
- [ ] E2E test: conditional breakpoint fires on correct iteration of a loop
- [ ] E2E test: exception breakpoint catches first-chance `ArgumentException`
- [ ] E2E test: exception breakpoint catches unhandled `NullReferenceException`
- [ ] E2E test: function breakpoint hits on named method entry

### 4.5 Stepping

- [ ] Proxy `next`, `stepIn`, `stepOut`, `continue`, `pause`
- [ ] Implement `goto` as temporary breakpoint + continue (run to cursor)
- [ ] Implement Just My Code skip: forward `justMyCode: true` to netcoredbg; document that Phase 4 JMC is basic
- [ ] E2E test: step over, step into, step out of a method call chain
- [ ] E2E test: Just My Code — step skips framework/library code on single step

### 4.6 Call Stack and Async Stack Enrichment

- [ ] Proxy `stackTrace` requests to netcoredbg
- [ ] Implement async stack enrichment in DapRouter:
  - [ ] Detect frames with compiler-generated state machine type names (`<MethodName>d__N` pattern)
  - [ ] Build side-channel request to C# sidecar: type name, `this` object address, frame index
  - [ ] C# sidecar: implement `ReconstructAsyncStack` handler using Roslyn type model
  - [ ] C# sidecar: read `<>1__state`, `<>4__this`, and continuation chain fields from heap via `ICorDebugObjectValue`
  - [ ] C# sidecar: walk `AsyncTaskMethodBuilder._builder._continuation`/`MoveNextRunner` to next logical frame
  - [ ] DapRouter: inject reconstructed logical frames into `stackTrace` response
  - [ ] DapRouter: degrade gracefully when reconstruction fails (return physical stack unchanged)
  - [ ] E2E test: paused inside `await Task.Delay`, logical stack shows caller chain (not raw `MoveNext`)
  - [ ] E2E test: 3-level async chain — all 3 logical frames visible
- [ ] Proxy `scopes`, `variables`, `source` requests
- [ ] E2E test: navigate to source from stack frame

### 4.7 Variable Inspection and Evaluation

- [ ] Proxy `variables` requests with structured variable response normalization
- [ ] Proxy `evaluate` requests (hover, watch, repl contexts)
- [ ] Implement `setVariable` proxy
- [ ] Implement DebuggerDisplay emulation in DapRouter:
  - [ ] On `variables` response, identify types with `[DebuggerDisplay]` attribute (via C# sidecar Roslyn lookup)
  - [ ] Send evaluate request to C# sidecar with format string and frame context
  - [ ] Replace default `toString()` value in response with evaluated display string
  - [ ] Fall back to raw class name if evaluation fails
  - [ ] E2E test: type with `[DebuggerDisplay("{Name} ({Id})")]` shows formatted string, not class name
- [ ] E2E test: inspect `List<int>` — items expanded correctly with indices
- [ ] E2E test: inspect `Dictionary<string, int>` — key-value pairs visible
- [ ] E2E test: modify int variable at runtime, continue — new value observed in subsequent line
- [ ] E2E test: hover over variable shows tooltip with value
- [ ] E2E test: watch expression `items.Count` evaluates correctly

### 4.8 Exception Handling

- [ ] Proxy `setExceptionBreakpoints` with full `filterOptions` support
- [ ] Implement inner exception chain traversal: DapRouter enriches exception variables with `InnerException` pseudo-variable chain
- [ ] E2E test: break on unhandled `NullReferenceException` — inspect message and stack
- [ ] E2E test: break on first-chance `ArgumentException` from specific namespace only

### 4.9 Hot Reload

- [ ] Implement `sharplsp/hotReload` custom notification handler in DapRouter
- [ ] Integrate with VFS: watch for document saves during active debug session
- [ ] C# sidecar: implement delta computation via Roslyn `WatchHotReloadService.GetUpdatesAsync`
- [ ] DapRouter: deliver delta to target process via DAP `evaluate` injection (call `MetadataUpdater.ApplyUpdate` via expression evaluation)
- [ ] Surface `sharplsp/hotReloadResult` notification to editor: success + changed methods list, or rejected changes + reason
- [ ] E2E test: edit method body while paused → continue → new behavior observed without restart
- [ ] E2E test: unsupported edit (method signature change) → user sees clear rejection message with rude edit type

### 4.10 F# Debugging (Phase 4)

- [ ] F# discriminated union display: DapRouter queries FCS sidecar to decode DU case metadata; rewrite `variables` display values from raw IL class names to F# syntax (`Some(42)` not `FSharpOption`1 { Tag=1, Value=42 }`)
- [ ] F# `task {}` async stack enrichment: apply same async stack reconstruction as C# with F# compiler-generated state machine name patterns
- [ ] F# `async {}` stack enrichment: best-effort CPS chain reconstruction; fall back to physical stack
- [ ] F# record inspection: map compiled backing field names to F# record field names
- [ ] F# tuple inspection: display as `(value1, value2)` syntax
- [ ] Test debugging: set `VSTEST_HOST_DEBUG=1` in test debug launch; attach to test host child process (not parent `dotnet test` process)
- [ ] E2E test: debug F# console app, inspect discriminated union value — shows F# syntax
- [ ] E2E test: step through F# pipeline operator chain
- [ ] E2E test: debug Expecto test with breakpoint inside test body

### 4.11 Multi-Process Debugging

- [ ] Implement `DebugSessionRegistry` in DapRouter (concurrent map of session ID → adapter process)
- [ ] Support multiple concurrent debug sessions with independent adapter processes
- [ ] Implement compound launch: parse list of named launch configs, start all sequentially
- [ ] E2E test: two processes debugged simultaneously, independent breakpoint in each

### 4.12 Test Debugging Integration

- [ ] Implement `sharplsp/testDebug` custom request handler
- [ ] Build DAP launch config for test host: `dotnet test --no-build` with `VSTEST_HOST_DEBUG=1`
- [ ] Resolve test host child process PID (watch for child process creation event)
- [ ] Wire test filter (class/method) into `dotnet test --filter` argument
- [ ] E2E test: breakpoint inside xUnit test method, `sharplsp/testDebug` → breakpoint hit
- [ ] E2E test: breakpoint inside NUnit test method
- [ ] E2E test: breakpoint inside Expecto test function (F#)

### 4.13 Phase 4 Quality Gates

- [ ] All P1 breakpoint types work reliably on Linux x64
- [ ] All P1 breakpoint types work reliably on macOS ARM64 (SharpLsp-built netcoredbg)
- [ ] All P1 breakpoint types work reliably on Windows x64
- [ ] Logpoint emulation verified on all platforms — fires message, never pauses
- [ ] Async stack enrichment: `MoveNext` frames replaced with logical frames in ≥90% of test cases
- [ ] DebuggerDisplay emulation: T1/T2 format strings rendered correctly for types with the attribute
- [ ] F# DU inspection: shows F# syntax not IL class names
- [ ] No crash in DapRouter when netcoredbg crashes (clean recovery, user-visible notification)
- [ ] Attach reliability: ≥95% success rate across 20 consecutive attach attempts in E2E tests
- [ ] Full E2E test suite passes in CI on Linux x64, macOS ARM64, Windows x64

---

## Phase 5 — SharpLsp Debug Sidecar (Months 21–26)

Goal: Replace netcoredbg with a C# Tier 4 sidecar achieving full vsdbg parity. Close all gaps documented in DEBUGGING-SPEC §7.

---

### 5.1 Debug Sidecar Bootstrap

- [ ] Create `sidecar/debug/` — new C# project (`SharpLsp.Debug.Sidecar`), .NET 9, nullable enabled
- [ ] Add `ClrDebug` 0.3.4+ NuGet dependency (managed ICorDebug wrappers; source-generated COM interop on .NET 8+)
- [ ] Add `Microsoft.Diagnostics.DbgShim` 9.0.661903+ NuGet dependency
- [ ] Add `Microsoft.Diagnostics.NETCore.Client` 9.0.661903+ NuGet dependency
- [ ] Implement DAP stdin/stdout transport (Content-Length framing, JSON-RPC)
- [ ] Implement `initialize` request handler: report full Phase 5 capability set
- [ ] Implement IPC channel to Rust host (MessagePack socket, same protocol as other sidecars)
- [ ] Implement adapter registration: DapRouter auto-selects Debug Sidecar when present; falls back to netcoredbg

### 5.2 ICorDebug Core

- [ ] Implement `ICorDebugManagedCallback` — all callbacks:
  - [ ] `Breakpoint`, `StepComplete`, `Break`, `Exception`, `EvalComplete`, `EvalException`
  - [ ] `CreateProcess`, `ExitProcess`, `CreateThread`, `ExitThread`
  - [ ] `LoadModule`, `UnloadModule`, `LoadClass`, `UnloadClass`
  - [ ] `DebuggerError`, `LogMessage`, `LogSwitch`
  - [ ] `CreateAppDomain`, `ExitAppDomain`, `LoadAssembly`, `UnloadAssembly`
  - [ ] `UpdateModuleSymbols`, `BreakpointSetError`
- [ ] Implement `DbgShim` bootstrap: `RegisterForRuntimeStartup` for attach; `EnumerateCLRs` for already-running processes
- [ ] Implement async-safe event dispatch loop with `ICorDebugController::Continue`
- [ ] Implement thread enumeration and management

### 5.3 Launch and Attach

- [ ] Implement `launch`: `CreateProcess` with debug flag + `ICorDebug::DebugActiveProcess`
- [ ] Implement `attach`: `DbgShim.RegisterForRuntimeStartup` (race-free; no `0x80070057`)
- [ ] Implement attach-by-name: resolve PID then attach
- [ ] Implement child process auto-attach via `ICorDebugManagedCallback::CreateProcess`
- [ ] E2E test: reliable attach — 20 consecutive attaches succeed (regression for netcoredbg issue #205 scenario)

### 5.4 Full Breakpoint Implementation

- [ ] Implement line breakpoints via `ICorDebugCode::CreateBreakpoint`
- [ ] Implement function breakpoints via `ICorDebugFunction::CreateBreakpoint`
- [ ] Implement exception breakpoints via `ICorDebugProcess` exception flags + first-chance filter
- [ ] Implement conditional breakpoints: full C# expression via Roslyn eval pipeline (§5.6)
- [ ] Implement hit-count breakpoints: counter in `Breakpoint` callback handler
- [ ] **Implement native logpoints**: evaluate log expression via `ICorDebugEval`, output DAP `output` event, call `Continue` immediately — zero pause latency
- [ ] **Implement data breakpoints**: field polling on `StepComplete` events; hardware watchpoints via platform APIs where available
- [ ] **Implement instruction breakpoints** via IL offset at `ICorDebugCode` level
- [ ] Implement `setDataBreakpoints` DAP request handler
- [ ] E2E test: native logpoint fires in <50ms, execution never pauses
- [ ] E2E test: data breakpoint fires when `_count` field changes from 4 to 5

### 5.5 Full Call Stack with Async Reconstruction

- [ ] Implement `stackTrace` via `ICorDebugThread` → `ICorDebugChain` → `ICorDebugFrame` full traversal
- [ ] Implement full async logical stack: direct heap traversal for continuation chains via `ICorDebugProcess::ReadMemory` (faster than Phase 4 Roslyn model approach)
- [ ] Implement parallel stacks: enumerate all threads, build frame graphs, expose as `sharplsp/parallelStacks` custom event
- [ ] **Implement restart frame**: `ICorDebugILFrame::CanSetIP` check → `ICorDebugILFrame::SetIP` to first IL offset
- [ ] Implement `restartFrame` DAP request handler
- [ ] E2E test: 5-level async chain — logical stack shows all 5 caller frames
- [ ] E2E test: restart frame — execution resumes from beginning of current method

### 5.6 Full Expression Evaluation (Roslyn Pipeline)

- [ ] Implement expression compilation pipeline:
  - [ ] Debug Sidecar receives `evaluate` request with expression string + frame context (locals, `this`, scope)
  - [ ] Sidecar sends IPC request to C# sidecar (Roslyn) to compile expression in scope context via `CSharpScriptCompilation`
  - [ ] Roslyn returns compiled IL bytes for in-memory assembly
  - [ ] Debug Sidecar allocates memory in target process via `ICorDebugProcess::WriteMemory`
  - [ ] Debug Sidecar creates `ICorDebugEval`, calls `ICorDebugEval::CallFunction` with compiled method
  - [ ] Debug Sidecar waits for `EvalComplete`/`EvalException` callback; deserializes `ICorDebugValue` result
  - [ ] Result returned as structured DAP `evaluate` response
- [ ] E2E test: `myList.Where(x => x > 5).Count()` in watch window returns correct value
- [ ] E2E test: multi-statement expression `int s = items.Sum(); return s * 2;` evaluates correctly
- [ ] E2E test: LINQ query over `IEnumerable<T>` with 1000 items evaluates in <100ms

### 5.7 DebuggerDisplay, TypeProxy, Browsable

- [ ] **Implement native `[DebuggerDisplay]`**: evaluate format string via `ICorDebugEval` in target process; return display string
- [ ] **Implement `[DebuggerTypeProxy]`**: detect attribute; instantiate proxy type via eval; expand proxy members instead of raw object
- [ ] **Implement `[DebuggerBrowsable]`**: honour `Never`, `RootHidden`, `Collapsed` visibility flags
- [ ] E2E test: `[DebuggerDisplay("{Name} ({Id})")]` type shows `"Alice (42)"`, not class name
- [ ] E2E test: `[DebuggerTypeProxy(typeof(DictionaryProxy))]` on `Dictionary<K,V>` shows formatted key-value pairs
- [ ] E2E test: `[DebuggerBrowsable(Never)]` field is hidden from variables panel

### 5.8 Variable Inspection Enhancements

- [ ] **Implement return value display**: `ICorDebugILFrame::GetReturnValueForILOffset` after step-over; synthesize `returnValue` pseudo-variable under `Return Value` scope (DAP 1.67+ `returnValue` presentation hint)
- [ ] Implement raw memory read/write: `readMemory` / `writeMemory` DAP requests via `ICorDebugProcess`
- [ ] Implement disassembly: `disassemble` request using `ICorDebugCode::GetCode` → IL disassembly with source mapping
- [ ] Implement completions in evaluate: `completions` DAP request routed to Roslyn C# sidecar for in-scope symbol completion
- [ ] Implement C# 12 primary constructor parameter inspection: map compiler-generated backing fields to source parameter names
- [ ] Fix `Nullable<T>` expansion: resolve `HasValue`/`Value` fields correctly for all value types (regression test for netcoredbg issue #213)
- [ ] E2E test: `Nullable<Guid>` with value expands to show `HasValue: true`, `Value: {guid-string}`
- [ ] E2E test: return value of `ComputeTotal()` shown as `42` after step-over

### 5.9 Hot Reload — Full Implementation

- [ ] Move Hot Reload delivery from DapRouter eval injection to Debug Sidecar direct `MetadataUpdater.ApplyUpdate` call
- [ ] Implement delta caching: avoid re-compiling unchanged methods within a session
- [ ] Implement multi-assembly delta application
- [ ] Implement Rude Edit detection and reporting: surface edit type and reason to editor
- [ ] E2E test: edit + continue round-trip completes in <1s on a 50-method project
- [ ] E2E test: add new method to class while debugging — new method callable immediately

### 5.10 F# Debugging (Phase 5)

- [ ] F# `task {}` async stack: full logical reconstruction via direct heap traversal
- [ ] F# `async {}` stack: best-effort CPS chain reconstruction (improved from Phase 4 heuristics)
- [ ] F# expression evaluation: route `evaluate` to FCS sidecar for F# expression compilation; evaluate via `ICorDebugEval`
- [ ] F# discriminated union: native DU-aware formatting via FCS sidecar (not just display string — full structural expansion)
- [ ] F# mailbox processor: expose message queue depth as pseudo-variable in variables panel
- [ ] Smart Step Into for F# pipelines: implement `stepIn` with `targetId` (DAP `supportsStepInTargetsRequest`)
- [ ] Contribute `StateMachineMethod` PDB table emission to dotnet/fsharp (or maintain SharpLsp-local patch)
- [ ] E2E test: `task { }` async chain — full logical stack with no `MoveNext` frames
- [ ] E2E test: F# watch expression `List.length myList` evaluates correctly
- [ ] E2E test: Smart Step Into on `list |> List.map f |> List.filter g` — user selects `f` or `g`

### 5.11 Remote Debugging (Full)

- [ ] Implement SSH tunnel management in DapRouter: connect, upload binary, start adapter, forward port
- [ ] Implement `sourceFileMap` path remapping for remote paths
- [ ] Implement remote binary upload with progress reporting via `sharplsp/debugAdapterStatus`
- [ ] E2E test: debug .NET app running in Linux Docker container from macOS host

### 5.12 Phase 5 Quality Gates

- [ ] All DAP capability flags match Phase 5 capability matrix in DEBUGGING-SPEC §4
- [ ] Expression evaluation: LINQ + lambda tier (T3) passes all test cases
- [ ] Async logical stack: 100% of C# async test cases show logical frames (zero `MoveNext` frames)
- [ ] Data breakpoints: field change detection works for reference and value types
- [ ] Logpoints: native implementation; latency <50ms verified by timing test
- [ ] Return value display: shown for all non-void step-overs
- [ ] DebuggerDisplay/TypeProxy/Browsable: all three attributes work natively
- [ ] `Nullable<T>`, primary constructor params: inspection works for all tested types
- [ ] F# debugging: DU inspection + F# async stack + expression eval verified
- [ ] Remote debugging: full round-trip E2E test against Docker container
- [ ] No regression on any Phase 4 test case

---

## Continuous: Upstream Contributions

- [ ] Samsung/netcoredbg: contribute logpoint native implementation (Phase 4 emulation algorithm documented for upstream adoption)
- [ ] Samsung/netcoredbg: contribute macOS ARM64 CI and official binary release
- [ ] Samsung/netcoredbg: contribute musl/Alpine stack size workaround + dotnet/runtime#103741 upstreaming
- [ ] Samsung/netcoredbg: contribute async stack reconstruction (algorithm from §5.4.1)
- [ ] Samsung/netcoredbg: track and test fix for attach reliability issue #205
- [ ] Samsung/netcoredbg: track and test fix for stability regression #217, #206
- [ ] Samsung/netcoredbg: contribute `[DebuggerDisplay]` rendering (from SharpDbg implementation learnings)
- [ ] dotnet/fsharp: contribute `StateMachineMethod` PDB table emission (issue #12000)
- [ ] dotnet/runtime: contribute musl `EnsureStackSize` fix (issue #103741)
- [ ] lordmilko/ClrDebug: contribute any missing ICorDebug interface wrappers discovered during Phase 5
- [ ] MattParkerDev/SharpDbg: evaluate as Phase 5 foundation; contribute if adopted
