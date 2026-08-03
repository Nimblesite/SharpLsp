---
layout: layouts/docs.njk
title: Profiler
eleventyExcludeFromCollections: true
---

![Profiler in VS Code](/assets/screenshots/vscode-profiler-page.png)

# Profiler

SharpLsp exposes .NET trace, counter, dump, and heap-analysis workflows in the VS Code sidebar. These operations run in the Rust host and do not depend on either language sidecar.

## Required Tools

Install the Microsoft diagnostic tools you need:

```sh
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-dump
```

SharpLsp checks `PATH` first and then the conventional `.dotnet/tools` directories under the current user's home. It does not run `dotnet tool list -g`. A missing tool produces an error containing the corresponding install command.

## Profiler View

The **Profiler** view shows:

- active trace and counter sessions;
- discoverable .NET processes with PID and command line;
- per-session output paths and controls.

Refresh updates the process list. Process context actions can start a trace, start counters, collect a dump, copy the PID, or terminate the process.

## Traces

1. Run **SharpLsp: Start Performance Trace** and select a .NET process.
2. Run **SharpLsp: Stop Performance Trace**, or stop the session from its tree item.
3. SharpLsp finalizes the `.nettrace`, converts it to SpeedScope JSON, and opens the SpeedScope viewer.

With no explicit request values, the current trace request defaults to 30 seconds and writes under `.sharplsp/profiles`. Opening an existing `.nettrace` can also convert it to SpeedScope format.

## Live Counters

**Start Counter Monitoring** launches `dotnet-counters` for a selected process and opens a live webview. The default provider is `System.Runtime` with a one-second refresh interval. Counter updates arrive through `sharplsp/profiler/counterUpdate` notifications until the session stops.

## Dumps and Heap Analysis

The extension can:

- collect Heap, Full, or Mini dumps;
- run `dumpheap -stat` and display type counts and sizes;
- compare two dump snapshots;
- guide a baseline → exercise → comparison leak-detection workflow;
- inspect an object by address;
- build a bounded object-reference graph and identify GC roots.

Heap diffing classifies growth suspects from count and size deltas. These are heuristics, not proof of a leak; confirm a suspect with retention paths and application behavior.

## Main Commands

| Command | Purpose |
|---|---|
| `SharpLsp: Refresh Profiler` | Refresh processes and sessions |
| `SharpLsp: Start Performance Trace` / `Stop Performance Trace` | Record and finish a trace |
| `SharpLsp: Open Trace File…` / `Convert .nettrace to SpeedScope` | Open or convert trace files |
| `SharpLsp: Start Counter Monitoring` / `Stop Counter Monitoring` | Monitor runtime counters |
| `SharpLsp: Collect Memory Dump` | Capture a memory dump |
| `SharpLsp: Analyze Heap Dump` | Display heap statistics |
| `SharpLsp: Compare Heap Snapshots` | Diff two dumps |
| `SharpLsp: Detect Memory Leaks` | Run the guided snapshot workflow |
| `SharpLsp: Show Object Retention Graph` | Visualize object references |
| `SharpLsp: Inspect Object` | Show one object's fields and references |

## Configuration Status

`sharplsp.toml` accepts the complete profiler schema shown on the [Configuration](/docs/configuration/) page. Currently only `profiler.max_concurrent_sessions` is applied to runtime behavior. The other profiler default fields are parsed but commands still use their built-in request defaults; changing them does not yet reconfigure trace duration, output format, counter providers/interval, or output directory.

The default session limit is five. Exceeding it returns an error rather than replacing an existing session.

## Safety and Errors

Profiler commands validate PIDs, files, session IDs, and tool availability and return errors through LSP. The process tree also has an explicit terminate action; use it carefully because it ends the selected external process.
