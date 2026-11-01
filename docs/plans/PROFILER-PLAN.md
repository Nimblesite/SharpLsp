# Profiler Implementation Plan

**Spec:** [PROFILER-SPEC.md](../specs/PROFILER-SPEC.md)

Tracks progress against the spec. Every checked item has implementing code and a coarse e2e test.

## Status Legend

- `[x]` — implemented and tested
- `[~]` — implemented, tests incomplete
- `[ ]` — not started

## Tier 1 — Process & Session Plumbing

- [x] `sharplsp/profiler/listProcesses` (via `dotnet-trace ps`)
- [x] `sharplsp/profiler/startTrace` (spawns `dotnet-trace collect`)
- [x] `sharplsp/profiler/stopTrace` (SIGINT + auto-convert to SpeedScope)
- [x] `sharplsp/profiler/startCounters` (streaming notifications)
- [x] `sharplsp/profiler/stopCounters`
- [x] `sharplsp/profiler/collectDump`
- [x] Session store (`DashMap<String, ProfileSession>`) with lifecycle states
- [x] Tool discovery (PATH, then the `.dotnet/tools` shim roots — never `dotnet tool list -g`)
- [x] Configurable `max_concurrent_sessions` via `sharplsp.toml` (`[profiler]`, default 5, validated positive; applied at startup)
- [x] Orphaned-session cleanup on LSP shutdown (`SessionStore::shutdown` kills child tools before the sidecars stop)

## Tier 2 — Trace File Management

- [x] `sharplsp/profiler/convertTrace` — standalone conversion entrypoint for any `.nettrace`
- [x] `sharplsp.profiler.openTrace` command — user picks a trace file, SharpLsp converts+opens
- [x] Automatic SpeedScope conversion on session stop (when data was captured)
- [x] Chromium-format conversion through `convertTrace` (`format: "chromium"`); `test_profiler_convert_trace_full_stack_chromium` captures a real trace and verifies the nonempty `.chromium.json` output. The VS Code command defaults to SpeedScope.

## Tier 3 — Heap & Memory

- [x] `sharplsp/profiler/analyzeHeap` (top-level heap stats)
- [x] `sharplsp/profiler/findGCRoots`
- [x] `sharplsp/profiler/inspectObject`
- [x] `sharplsp/profiler/diffHeapSnapshots`
- [x] `sharplsp/profiler/getObjectGraph`
- [x] Leak classification heuristics (High/Medium/Low)
- [x] Known-leak-pattern elevation (event handlers, `CancellationTokenSource`, timers); `heap_diff` classification and pattern tests pass in the complete Rust suite.
- [x] Retained-size calculation (`objsize`) per node; the real fixture dump proves inclusive size exceeds shallow size, independently of graph display limits.

## VSCode Extension — UX (tree view, commands)

- [x] `ProfilerTreeProvider` with sessions + processes sections
- [x] `contextValue` on every tree item (sessions, processes, headers)
- [x] Default-click command per node kind:
  - Trace session → stop + open in SpeedScope
  - Counters session → reveal live webview
  - Process → start trace on this PID
- [x] Markdown tooltips with identity + output path + action hint
- [x] `view/item/context` menu entries for session and process nodes:
  - Trace session: Stop & Open · Reveal Output · Copy Output Path
  - Counters session: Show Panel · Stop
  - Process: Trace · Counters · Collect Dump · Copy PID
- [x] Inline icon actions on session nodes (stop trace; show counters panel)
- [x] Toolbar reorg: Refresh + Open Trace on navigation, rest to overflow
- [x] Status bar item with session count
- [x] Live counter webview (color-coded table, auto-refresh)
- [x] Heap stats text document output
- [x] Object graph webview (D3.js force-directed)
- [x] Heap diff webview with growth indicators
- [x] Leak detection workflow (baseline → exercise → compare)
- [x] Progress indicators for long-running operations (dump collection, heap analysis, object inspection, graph traversal and snapshot comparison).
- [x] "Cancel" button on the progress notification; the LSP message loop stays responsive, cancellation terminates the diagnostic child, and a subsequent dump and analysis succeed.

## Testing

- [x] `stopTrace` produces a non-empty `.nettrace` and auto-converts
- [x] `startCounters` delivers at least one `counterUpdate` notification
- [x] `analyzeHeap` returns deterministic type counts on a fixture dump
- [x] [PROFILER-SESSIONS-LIFECYCLE] The real `ProfileTarget` exits if its creator
  dies before watchdog startup, including under a Linux child subreaper (10
  consecutive orphan-process regressions and the full 701-test Rust coverage
  suite passed; issue #3).
- [x] e2e: click process node → trace session appears in tree
- [x] e2e: click trace session → session disappears and SpeedScope URL opens
- [x] e2e: right-click trace session → every menu entry invocable; the screenshot run checks all three real menu entries and clicks Copy Output Path, while command regressions exercise reveal and stop/open.
- [x] e2e: `openTrace` command on a standalone `.nettrace` file → SpeedScope opens
- [x] Browser regression: bundled D3 renders labelled edges, retained-size encoding, reactive filters and summaries, nested expansion, inspect/collapse gestures, root paths, depth changes, SVG/PNG export and snapshot-growth annotations.
- [x] Malformed graph data is rejected without losing the current graph; the next valid update succeeds. Labels follow light/dark themes, and SVG/PNG exports retain readable foreground/background colors. Browser sources use the same strict lint and formatting rules as the extension.
- [x] e2e: `test_profiler_convert_trace_full_stack_chromium` converts the same real capture twice and asserts the same output path and file size

## Documentation

- [x] PROFILER-SPEC.md covers tree UX, context menus, and trace file conversion
- [x] Command catalogue in spec matches `package.json` contributions
- [x] Screenshots of the tree view + context menus in the spec; captured from a real `ProfileTarget` trace on 2026-10-03.
- [x] User-facing README section on "Opening a trace file"

## Known Issues

- Orphaned `.nettrace` files (from editor crash mid-recording) accumulate in `.sharplsp/profiles/`. Need a cleanup command.
- No upper bound on `.sharplsp/profiles/` size — large dumps can fill the disk silently.
- SpeedScope external viewer is opened via `vscode.env.openExternal`; users on air-gapped networks lose the visualisation. Bundle SpeedScope locally as a follow-up.

## [PROFILER-PLAN-VERIFICATION] Completion evidence

The implementation checklist and regression verification were completed on **2026-10-04**. The release-wide security gate remains blocked by the unpatched website dependency advisory tracked in [BUG #324](https://github.com/Nimblesite/SharpLsp/issues/324); completing this profiler plan does not waive that gate.

| Editor matrix | Chunks passed | Tests passed | Existing skips |
|---|---:|---:|---:|
| Windows | 15/15 | 1,380 | 4 |
| Linux | 13/13 | 1,326 | 0 |

Both matrices include a final workspace rerun with the completed graph changes: **497 passed on Windows**, **498 on Linux**. The four existing Windows skips cover the Unix-only probe timeout, case-sensitive paths and two upstream netcoredbg attach cases; their Linux counterparts passed. No tests or assertions were removed or weakened.

- Complete Rust suites: **703 passed on Windows** and **707 passed on Linux**, zero skipped; coverage was 95.22% and 95.23%, respectively. Both include the real-dump retained-size assertion and cancellation/recovery regression.
- The expanded browser suite passed all **8** regressions in both editor matrices and against the minified production bundle, including malformed-message recovery, theme/export contrast, search, summaries, nested expansion/collapse and snapshot annotations. The real-process screenshot workflow also passed.
- `profiler-release.test.ts` exercises actual diagnostics tools, absolute trace output paths, reactive tree changes, stop/conversion/reopen, progress cancellation and recovery. `profiler-graph-browser.test.ts` executes the bundled graph code in Chromium.
- Combined editor coverage across all **28** final tracefiles passed at **97.9666%** (105,369/107,556 lines). The gate ratcheted `vscode-extension` from **96.67% to 96.96%**, and passed again against the raised threshold. The existing tolerance was unchanged.
- All **1,100 sidecar tests** passed on both Windows and Linux, along with **21 Windows named-pipe transport tests**. All Linux coverage gates passed: C# 95.20%, F# 94.42%, Common 95.72%, using the existing thresholds and tolerance.
- Website regression suite: **222 passed** across desktop and both mobile configurations, including Japanese/Chinese content parity.
- Tooling tests: **59 passed**. Zed's **31 tests**, Rider tests and both editor coverage gates passed; their release archives were built successfully.
- Strict TypeScript lint, CI-pinned formatting, type checking, spec citations, Rust formatting/clippy on both platforms and .NET lint passed. Deslop measured **9.6183%**, below the tightened **9.65%** threshold, with no new identical/nearly-identical profiler clusters.
- Windows and Linux VSIX packages were built and verified. Their host and sidecar hashes match the tested binaries; both contain netcoredbg, the graph bundle and its dependency licenses, and exclude development source maps.
- Dependency audits passed for Rust, .NET and the VS Code extension. The website audit reports **six high-severity findings in the unpatched `braces` dependency chain** ([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)); no exception or suppression was added. Release publication remains blocked by #324.

Cancellation scheduling is host infrastructure that overlaps the generic `lspkit` migration. Any PR carrying this change must flag that overlap and reference the upstream request-dispatch/lifecycle work.

## [PROFILER-PLAN-MIGRATION] Migration to lsp-profiler

**Spec:** [PROFILER-SHARED-LIBRARY]. The library side is tracked in lspkit's plan, `lspkit/docs/plans/LSP-PROFILER-PLAN.md` (https://github.com/Nimblesite/lspkit).

Every item below is unchecked until its code and a coarse e2e test exist. Status verified on **2026-10-15**. The old profiler code and suites were deleted on that date, once the library's host, extension and e2e suites replaced them; the gaps below name what the deletion left uncovered.

### Parity

These are SharpLsp's shipped profiler features. Cutover is blocked until each row is delivered by the library or explicitly dropped by the owner.

| Shipped today | After migration | Library status |
|---|---|---|
| CPU trace (`dotnet-trace`) opened in the external SpeedScope viewer | CPU session: hot lines and functions in the editor as decorations (inlay hints and lenses when the library builds them); speedscope, flame-graph and `.cpuprofile` exports; results panel | **Delivered** (`profiler_shared` e2e, `profiler-cpu-e2e.test.ts`) |
| Live counters webview | Neutral metrics capability | **Gap**: not yet specified |
| Collect dump | Memory snapshot; the dump kept on request for external tools | **Gap**: keep-on-request not yet specified |
| Analyze heap (`dumpheap -stat`) | Snapshot live-type stats over EventPipe (no dump), counting only reachable objects and anchored at each type's declaration | **Delivered** |
| Find GC roots | Retention graph with labelled static, stack and handle roots | **Delivered** (`static Items` root reached in both e2e suites) |
| Inspect object | Neutral `inspect` step | **Gap**: not yet specified |
| Diff snapshots and leak classification (High/Medium/Low) | Compare and leak-confidence streaks | **Delivered** (`memory-e2e.test.ts`) |
| Known-leak-pattern elevation (event handlers, `CancellationTokenSource`, timers) | A runtime-supplied leak hint that decides on resolved type identity in the dump, never on name strings | **Gap**: not yet specified |
| Retained size per graph node | `RefNode.retained_bytes` from a dominator computation in the engine | **Gap**: not yet specified |
| Open or convert a `.nettrace` | Neutral `import` command through the same symbolizer | **Gap**: not yet specified |
| Kill process (confirmed) | `kill` with modal confirmation | **Delivered** (`sharplsp.profiler.killProcess`) |
| Profiler tree: sessions and processes | Processes view and session state | **Delivered** (library processes view, status bars) |
| Cancellable progress and recovery | `$/cancelRequest` → `-32800` (delivered, `profiler_shared` e2e); work-done progress | Progress is still the library's notification |
| Retention-graph UI: nested expansion, filters, SVG/PNG export, theme contrast | Same features on the library's neutral graph | **Gap**: deleted with the old extension, not yet ported into the library |
| Counters-driven leak hints, inspect object, retained size, open `.nettrace` | See the rows above | **Gaps**, unchanged |

### Rust host

- [x] Depend on `lsp-profiler` and `lsp-profiler-dotnet` from crates.io and `@nimblesite/lsp-profiler-ui` from npm; the lspkit submodule is gone.
- [x] Profiler wiring in `src/sharplsp/src/main.rs` replaced by `profiler::host::ProfilerHost` (`HostServices`): construction under the workspace root, shutdown before the sidecars, executeCommand routing, `$/cancelRequest`, `executeCommandProvider` and `experimental.lspProfiler` [PROFILER-SHARED-LIBRARY-HOST]. The `sharplsp/profiler/*` routes are gone.
- [ ] Merge the profiler's diagnostics, inlay hints, code lenses and code actions with SharpLsp's own providers (blocked on the library building them).
- [x] `[profiler]` table reduced to `max_concurrent_sessions` and `output_directory`; CLI-only settings removed (`config.rs`). The cap is not enforced by the library yet.
- [x] Engine path resolved in `paths.rs` (`profiler_engine_path`).
- [x] .NET classification and the endpoint check **moved** into `lsp-profiler-dotnet` (`crates/lsp-profiler-dotnet/src/process.rs`, with tests) and deleted here.
- [x] The rest of `src/sharplsp/src/profiler/` deleted (4,949 lines); `profiler/mod.rs` exports only `host`. Dead path helpers (`has_name_suffix`, `absolute_output`, `ensure_output_dir`, `names_executable`) and `utils::hide_console_window` went with it. 205 unit tests pass; clippy clean.

### VS Code extension

- [x] Pack one Signals runtime for ESM host imports and CommonJS profiler imports. The production-bundle regression verifies consecutive updates and disposal; the live CPU test verifies progress in the development host.
- [x] Resolve symlinked source paths in the shared library on macOS and Windows; regression opens the real HotLeakApp project through a symlink/junction.

- [~] `@nimblesite/lsp-profiler-ui` as a **`file:` dependency** on the sibling checkout, activated from `extension.ts` through `src/profiler-host.ts` with prefix `sharplsp` [PROFILER-SHARED-LIBRARY-VSCODE]. Publishing is open.
- [ ] **Graph features were not moved before deletion.** `profiler-graph*.ts`, `profiler-graph-webview.mts`, `profiler-graph-browser.test.ts` and `profiler-graph-test-kit.ts` are deleted; their sources are in history. Porting nested expansion, filters, SVG/PNG export, theme contrast and malformed-message recovery onto the library's retention graph, with the browser regressions, is open and listed in the parity table.
- [x] `profiler.ts`, `profiler-diff.ts`, `profiler-graph.ts`, `profiler-graph-html.ts`, `profiler-graph-message.ts`, `profiler-graph-types.ts`, `profiler-graph-webview.mts`, `profiler-prompts.ts` and `profiler-request.ts` deleted; the esbuild webview entry removed; `launch-profiles.ts` and `dotnet-process.ts` stay (used by debugging and testing).
- [x] `package.json` profiler contributions replaced by the generated catalogue (`tools/vsix/sync-profiler-contributions.mjs`); stale `cmd.profiler.*` / `view.profiler.name` nls keys removed from every locale. `profiler.test.ts` checks the manifest, and `_lint-vsix` runs the sync script's `--check`.
- [x] The engine is staged beside the host binary by `_copy-vsix-binaries` [PROFILER-SHARED-LIBRARY-ENGINE]. macOS verified locally; Windows and Linux VSIX payload verification passed in CI run `38799469697`.

### Tests

- [x] Rust e2e: the five old modules are replaced by `e2e_modules/profiler_shared.rs` (5 tests, pass): the server advertises the commands and the `dotnet` runtime; process listing finds `ProfileTarget` attachable with its version; CPU start twice is `-32004`, `cpu.list` shows the session, the report names `ProfileTarget`'s workers and writes all artifacts, stopping twice is `-32000`; memory snapshot → diff → references (target nodes, edges) → `gcCollect` observed → stop; dead PID `-32001`, non-.NET PID `-32002`, missing params `-32602`, foreign command rejected; `kill` on the test host is exactly `-32002` and on a dead PID `-32001`; cancelling an in-flight heap snapshot of a live session answers `-32800` and the session snapshots again afterwards. (The cancel test used to cancel a request on a missing session and accept `-32000`, which proved nothing; the kill test accepted any error.)
- [x] Extension: `profiler.test.ts`, `profiler-cpu-e2e.test.ts`, `memory-e2e.test.ts` and `profiler-kit.ts` replace `profiler.test.ts`, `profiler-e2e.test.ts` and `profiler-release.test.ts`; they port Basilisk's `profiler`, `profiler-memory-integration`, `profiler-cpu-e2e`, `memory-e2e`, `memory-introspection-e2e` and the interval mode of `memory-autopilot-e2e`. Not ported, with the feature: the graph browser suite. Not reproducible in direct mode: Basilisk's cooperative-sampler, courier-pause and breakpoint-autopilot flows. Screenshots not regenerated.
- [x] Extension, second wave (all against live `ProfileTarget` / `ProfileLeakTarget` processes over the real server): `profiler-processes.test.ts` (wire listing and its runtime facts, `in_workspace` per root, scope excludes the extension host, the store and welcome key, row id / tooltip with the runtime's display name / direct-memory contextValue, no click-to-open for a binary entry, pinned launches, copy PID, filter by PID and name and the honest placeholder, sort cycle and per-block PID order, group cycle and the version bucket, kill and its refusals); `profiler-cpu-sessions.test.ts` (`cpu.list` fields, mid-session snapshot, `-32004`, every preset's rate and an explicit override, unknown preset and out-of-range rate `-32602`, duration auto-end, two targets at once, a target dying mid-session, live chrome gated on `live_progress`, a refused second start, the branded results panel); `memory-flows.test.ts` (start refusals `-32001` / `-32002` / `-32602`, inspection before a snapshot refused, type-named sites resolved to source, timeline growth, objects largest first, empty walks for absent types, a stopped session refusing every step, cancellation, and the UI flow: chrome and keys, refused second start, the branded dashboard with type names, timeline, diff leaks by type, the reference picker offering the snapshot's own types, GC, stop clearing every overlay).
- [x] Extension, third wave: every Basilisk profiler VSIX suite (212 tests, all but the CLI-only `subprocess-mode`) has a SharpLsp counterpart under the same test names, run on the live extension through `profiler-ui-helpers.ts`: `profiler-commands`, `profiler-decorations`, `profiler-entrypoints`, `profiler-panel-reactive`, `profiler-ux`, `profiler-webviews`, `profiler-profile-server`, `profiler-process-explorer`, `profiler-process-reactive-store`, `profiler-memory-integration`, `memory-discoverability`, and the debug-launched suites `memory-autopilot-e2e`, `memory-introspection-e2e`, `memory-launch-e2e` and `profiler-cpu-launch-e2e` on a .NET debuggee built in the workspace (`profiler-ui-debuggee.ts`). Basilisk's hollow cases (a swallowed `assert.fail`, `assert.ok(true)`, heat levels asserted on literals) assert what the user sees instead. Python-only steps map to their .NET counterparts: no stop on entry, a heap read while the program runs, a refusal at a breakpoint.
- [x] Defects the third wave found and fixed: the router never announced a terminal-hosted debuggee's PID, so neither one-click launch could start; it now announces it once the attached runtime loads its first module, when the shell has become the program (`dap-replay.ts`); the client registered the 17 protocol commands as VS Code commands (`client.ts`); 22 dead old-profiler command constants (`constants.ts`); and in lspkit, Run & Track Memory waited for an entry pause a .NET launch never makes, the autopilot's pause capture had no caller, a .NET heap step at a breakpoint hung until the program resumed, profile-on-launch on macOS always took Python's cooperative path, profile-on-launch then refused its own attach as busy, and the .NET backend under-reported `live_progress`. A .NET heap read racing a debugger pause blocks until the program resumes, so in direct mode the autopilot captures on its interval only and a manual step at a breakpoint is refused at once.
- [x] F# end to end (`profiler-fsharp-e2e.test.ts`, against lspkit's `HotLeakAppFs`). v0.28.0 shipped with no F# profiling test, and the first F# run found three engine defects, #377, #378 and #379, fixed in lspkit#10:
  - F# records and unions had no source location, so the memory track painted nothing;
  - union cases were named `Small` instead of `HotLeakAppFs.PayloadKind+Small`;
  - a module value's root read `static items@15`.

  The suite pins each fix as the user sees it, in the heat map, the memory track, the dashboard and the retention graph.
- [x] Found while verifying the F# suite, and fixed:
  - Run locally, the profiler suites read a second copy of the UI library and saw every seam (status bar, decorations, panels) empty, because `npm run prepare:tests` built the production bundle. It now builds the development bundle that CI tests ([DIST-CI-ARTIFACT-TESTS]).
  - The Rust `profiler_shared` tests raced: each nextest process rewrote the engine beside the shared server binary while another test's engine started, and lost the race with "exited before attaching". The engine is now installed atomically.
  - The suites' lifecycle and flows live once in `profiler-kit.ts` (`profilingSuite`, `profileFromRowFor`, `stopTracking`, `snapshotSession`, `retentionGraph`). The Deslop gate is ratcheted from 6.73 % to 6.65 %.
- [x] The `profiler` chunk on macOS (`make _test-vsix-shard CHUNK=profiler`, 2026-10-15): **294 passing, 0 failing**, after the defects below were fixed; the debugger, manifest and configuration suites they touch pass too (30 passing).
- [x] F# on real programs: `FsPricingEngine` (CPU: CSV parsing, discount rules, fuzzy search, routing, reports) and `FsOrderLedger` (an event handler, a memoize cache, a mailbox audit trail, undo history and rejection capture, each rooted at its own module value), under `src/sharplsp/tests/fixtures/fsharp-profiling/`. The suites `profiler-fsharp-cpu-e2e`, `-memory-e2e`, `-retention-e2e`, `-corner-e2e`, `-soak-e2e`, `-soak-cpu-e2e` and `profiler-lsp-protocol-e2e`, `-cpu-e2e`, `-memory-e2e` drive them through the UI and over the wire. The defects they found are fixed in lspkit and the host:
  - idle samples counted as active, so a main thread waiting on stdin took half of every profile (lspkit#12);
  - a frame every thread shares counted once per thread, so its samples outnumbered the ticks (lspkit#12);
  - naming a runtime that cannot profile a busy PID answered `ALREADY_PROFILING`, not `UNSUPPORTED_RUNTIME` (lspkit#12);
  - a `ResizeArray<Order>`'s `Order[]` painted the line that builds an `Order` (lspkit#12);
  - a retention graph that left instances out still said it was complete (lspkit#12);
  - a memory step on a program that had exited answered `OTHER`, not `PROCESS_NOT_FOUND` (lspkit#12);
  - a second diff kept the first diff's leak badges (lspkit#12);
  - FSharp.Core types were placed at its build server's paths, which do not exist here (lspkit#13);
  - `objectsByType` dropped the requested type from its summary when it ranked below the twenty largest, as F# union cases do (lspkit#13);
  - the retention graph never drew a root's label, so a module value's `static sessions` looked like any holder (lspkit#14);
  - the timeline's peak fell after a release, because `peak_bytes` was each snapshot's own heap size (lspkit#15);
  - a heap snapshot taken during a CPU session named types by bare address, because the CPU session enabled the runtime provider (lspkit#15);
  - a hot function with no location reached the UI as file `""`, line 0 (lspkit#15);
  - the UI's Stop never sent `memory.stop`, so the server kept the session and its graphs and still answered steps (lspkit#15);
  - a timed CPU session never left `cpu.list` once its duration elapsed (lspkit#15);
  - the host accepted a profiler command with no argument, two arguments or a non-object argument (`profiler/host.rs`);
  - a sample in an F# `match`'s decision tree lost its file, so `Csv.parseLine` split into a located function and an unlocated twin holding 61% of its samples, and the Windows chunk failed on #406 (#408, lspkit#19);
  - FsOrderLedger's burn tick took the process-wide gate around every `priceAll` call. EventPipe's sampler stops a thread at its next safe point, so the uncontended lock call drew 98% of the burn thread's samples, and `priceAll` sat at the 2% hot-function threshold. The joint CPU and memory soak failed two runs in three on macOS. The tick only reads, so it now runs outside the gate, and `priceAll` is on every burn sample (#408).
- [ ] Assertions of the deleted suites with no replacement: counters webview and counter sessions, `openTrace`/`convertTrace` of a `.nettrace`, dump collection with cancellable progress, `inspectObject`, `diffSnapshots`/`detectLeaks` panels over dumps, graph browser interactions. Each maps to a parity gap above.

### Documentation and cutover

- [ ] Every parity row is delivered or dropped by the owner (open rows: counters, keep dump, inspect, known-leak hints, retained size, `.nettrace` import, graph UI).
- [ ] Delete the sections listed in [PROFILER-SHARED-LIBRARY-SUPERSEDED] (they still describe features whose parity is open).
- [ ] Update the README section "Opening a trace file" and the `dotnet tool install` hints, and the website screenshots.
- [x] Spec citations pass (checked 2026-10-15). New host code cites `PROFILER-SHARED-LIBRARY-*`.
- [ ] **Cutover**: the full Rust and editor suites pass on Windows and Linux, the coverage gates pass, and the VSIX packages are verified. On 2026-10-15 only macOS was run, and only the profiler suites of the extension.
