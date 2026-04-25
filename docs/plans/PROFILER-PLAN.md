# Profiler Implementation Plan

**Spec:** [PROFILER-SPEC.md](../specs/PROFILER-SPEC.md)

Tracks progress against the spec. Every checked item has implementing code and a coarse e2e test.

## Status Legend

- `[x]` — implemented and tested
- `[~]` — implemented, tests incomplete
- `[ ]` — not started

## Tier 1 — Process & Session Plumbing

- [x] `forge/profiler/listProcesses` (via `dotnet-trace ps`)
- [x] `forge/profiler/startTrace` (spawns `dotnet-trace collect`)
- [x] `forge/profiler/stopTrace` (SIGINT + auto-convert to SpeedScope)
- [x] `forge/profiler/startCounters` (streaming notifications)
- [x] `forge/profiler/stopCounters`
- [x] `forge/profiler/collectDump`
- [x] Session store (`DashMap<String, ProfileSession>`) with lifecycle states
- [x] Tool discovery (PATH + `dotnet tool list -g` fallback)
- [ ] Configurable `max_concurrent_sessions` via `forge.toml`
- [ ] Orphaned-session cleanup on LSP shutdown

## Tier 2 — Trace File Management

- [x] `forge/profiler/convertTrace` — standalone conversion entrypoint for any `.nettrace`
- [x] `forge.profiler.openTrace` command — user picks a trace file, Forge converts+opens
- [x] Automatic SpeedScope conversion on session stop (when data was captured)
- [ ] Chromium-format conversion wired through `convertTrace` param (handler accepts it; UI default is SpeedScope)

## Tier 3 — Heap & Memory

- [x] `forge/profiler/analyzeHeap` (top-level heap stats)
- [x] `forge/profiler/findGCRoots`
- [x] `forge/profiler/inspectObject`
- [x] `forge/profiler/diffHeapSnapshots`
- [x] `forge/profiler/getObjectGraph`
- [x] Leak classification heuristics (High/Medium/Low)
- [ ] Known-leak-pattern elevation (event handlers, `CancellationTokenSource`, timers)
- [ ] Retained-size calculation (`objsize`) per node

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
- [ ] Progress indicators for long-running operations (dump collection, heap analysis)
- [ ] "Cancel" button inline on in-progress operations

## Testing

- [x] `stopTrace` produces a non-empty `.nettrace` and auto-converts
- [x] `startCounters` delivers at least one `counterUpdate` notification
- [x] `analyzeHeap` returns deterministic type counts on a fixture dump
- [ ] e2e: click process node → trace session appears in tree
- [ ] e2e: click trace session → session disappears and SpeedScope URL opens
- [ ] e2e: right-click trace session → every menu entry invocable
- [ ] e2e: `openTrace` command on a standalone `.nettrace` file → SpeedScope opens
- [ ] e2e: `convertTrace` idempotence (re-running produces same output file)

## Documentation

- [x] PROFILER-SPEC.md covers tree UX, context menus, and trace file conversion
- [x] Command catalogue in spec matches `package.json` contributions
- [ ] Screenshots of the tree view + context menus in the spec
- [ ] User-facing README section on "Opening a trace file"

## Known Issues

- Orphaned `.nettrace` files (from editor crash mid-recording) accumulate in `.forge/profiles/`. Need a cleanup command.
- No upper bound on `.forge/profiles/` size — large dumps can fill the disk silently.
- SpeedScope external viewer is opened via `vscode.env.openExternal`; users on air-gapped networks lose the visualisation. Bundle SpeedScope locally as a follow-up.
