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
- [x] Tool discovery (PATH + `dotnet tool list -g` fallback)
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
