---
layout: layouts/docs.njk
title: Profiler
eleventyNavigation:
  key: Profiler
  order: 8
---

![Profiler in VS Code](/assets/screenshots/vscode-profiler-page.png)
![Profiler in Zed](/assets/screenshots/zed-profiler-page.png)

*Built-in profiler wrapping dotnet-trace, dotnet-counters, and dotnet-dump — zero context switching.*

# Profiler

Forge integrates the standard .NET diagnostic CLI tools directly into your editor. No terminal juggling, no separate GUIs. Trace performance, monitor live counters, and analyze memory dumps without leaving your code.

## Prerequisites

Install the .NET diagnostic tools globally:

```bash
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-dump
```

Forge auto-discovers these tools on PATH and via `dotnet tool list -g`. If a tool is missing, commands return an actionable error with the install command.

## Profiler Tree View

The **Profiler** panel in the Forge sidebar shows:

| Section | Content |
|---------|---------|
| **Active Sessions** | Running traces and counter monitors with session ID |
| **.NET Processes** | Discoverable processes with PID and command line |

Click **Refresh** to update the process list. The status bar shows the count of active profiling sessions.

## Performance Tracing (dotnet-trace)

Capture detailed performance traces and view them in SpeedScope.

### Start a Trace

1. Open the **Profiler** view in the Forge sidebar
2. Click the **Start Trace** button (or run `Forge: Start Trace` from the command palette)
3. Select a .NET process from the picker
4. The trace session appears in the tree view

### Stop a Trace

1. Run `Forge: Stop Trace` from the command palette
2. Select the active trace session
3. Forge converts the `.nettrace` to SpeedScope format and opens it in your browser

### Configuration

```toml
# forge.toml
[profiler]
# Default trace profile (cpu-sampling, gc-verbose, gc-collect, none)
default_profile = "cpu-sampling"

# Output format (speedscope, nettrace, chromium)
default_format = "speedscope"

# Auto-stop after duration (seconds, 0 = manual stop)
default_duration = 0

# Maximum concurrent profiling sessions
max_sessions = 5
```

## Live Counter Monitoring (dotnet-counters)

Monitor .NET performance counters in real time with a live-updating table.

### Start Monitoring

1. Run `Forge: Start Counters` from the command palette
2. Select a .NET process
3. A webview panel opens showing live counter values

### Counter Display

The counter webview shows a sortable table with columns:

| Column | Content |
|--------|---------|
| **Provider** | Counter provider (e.g., `System.Runtime`) |
| **Counter** | Counter display name |
| **Value** | Current value (formatted: bytes, counts, percentages) |
| **Unit** | Measurement unit |

Counters update in real time as `forge/profiler/counterUpdate` notifications stream from the server.

### Stop Monitoring

Run `Forge: Stop Counters` to end the session and close the webview.

## Memory Dumps (dotnet-dump)

Capture and analyze memory dumps to investigate leaks and high memory usage.

### Collect a Dump

1. Run `Forge: Collect Dump` from the command palette
2. Select a .NET process
3. Choose dump type: **Heap**, **Full**, or **Mini**
4. Forge saves the dump and reports the output path and file size

### Analyze Heap

1. Run `Forge: Analyze Heap` from the command palette
2. Select a `.dmp` file
3. Forge runs `dumpheap -stat` and displays a formatted table showing:
   - Type name
   - Object count
   - Total size (formatted as B/KB/MB)

## Commands

| Command | Description |
|---------|-------------|
| `Forge: Refresh Profiler` | Refresh the .NET process list |
| `Forge: List Processes` | Refresh and show .NET processes |
| `Forge: Start Trace` | Begin a performance trace on a .NET process |
| `Forge: Stop Trace` | Stop an active trace session |
| `Forge: Start Counters` | Start live counter monitoring |
| `Forge: Stop Counters` | Stop counter monitoring |
| `Forge: Collect Dump` | Capture a memory dump |
| `Forge: Analyze Heap` | Analyze heap statistics from a dump file |

## Performance Targets

| Operation | Target |
|-----------|--------|
| Process list refresh | <500ms |
| Trace start latency | <1s |
| Counter update delivery | <100ms from tool output to editor |
| Heap analysis (50k+ types) | <5s |
| GC root traversal | <10s |

## Error Handling

All profiler commands handle errors gracefully:

- **Tool not installed**: Returns an error with the exact `dotnet tool install` command
- **Invalid PID**: Returns an error without crashing the LSP server
- **Missing dump file**: Returns a clear error message
- **Session limit exceeded**: Returns an error when max concurrent sessions is reached
- **Sidecar independence**: Profiler runs entirely in the Rust host; sidecar crashes do not affect profiling
