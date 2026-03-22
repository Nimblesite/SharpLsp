# Forge for VS Code

The open-source .NET Language Server — C# and F# intelligence for every editor. Zero licenses. Zero vendor lock-in.

## Features

- **Code Completions** — IntelliSense-quality completions powered by Roslyn
- **Diagnostics** — Real-time errors and warnings as you type
- **Hover / Quick Info** — Full type signatures, XML docs, and nullability annotations
- **Go to Definition** — Jump to source or decompiled metadata
- **Document Symbols** — Fast outline via tree-sitter
- **Code Folding** — Syntax-aware region folding
- **F# Support** — First-class F# via FSharp.Compiler.Service
- **Solution Explorer** — Tree view of your .sln, projects, and symbols
- **Profiler** — Built-in .NET profiling, counter monitoring, and memory analysis

## Profiler

Forge wraps `dotnet-trace`, `dotnet-counters`, and `dotnet-dump` into a seamless editor experience. No terminal required.

### Setup

Install the .NET diagnostic tools:

```bash
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-dump
```

### Usage

Open the **Profiler** panel in the Forge sidebar to see running .NET processes.

| Action | How |
|--------|-----|
| **Trace performance** | `Forge: Start Trace` — select a process, trace runs until you stop it. Output opens in SpeedScope. |
| **Monitor counters** | `Forge: Start Counters` — live-updating table of .NET performance counters in a webview panel. |
| **Capture memory dump** | `Forge: Collect Dump` — choose Heap, Full, or Mini dump type. |
| **Analyze heap** | `Forge: Analyze Heap` — select a `.dmp` file to see type counts and memory usage. |

All commands are available from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).

## Requirements

- .NET SDK 9.0+
- `forge-lsp` binary (built from source or downloaded from releases)

## Configuration

Configure via `forge.toml` in your workspace root. See the [full documentation](https://melbournedeveloper.github.io/forge/docs/configuration/) for details.

## Links

- [Documentation](https://melbournedeveloper.github.io/forge/docs/)
- [GitHub](https://github.com/MelbourneDeveloper/forge)
- [Issues](https://github.com/MelbourneDeveloper/forge/issues)
