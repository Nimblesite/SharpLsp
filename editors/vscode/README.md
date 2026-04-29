# SharpLsp for VS Code

The open-source .NET Language Server — C# and F# intelligence for every editor. Zero licenses. Zero vendor lock-in.

## Features

- **Code Completions** — IntelliSense-quality completions powered by Roslyn
- **Diagnostics** — Real-time errors and warnings as you type
- **Hover / Quick Info** — Full type signatures, XML docs, and nullability annotations
- **Go to Definition** — Jump to source or decompiled metadata
- **Document Symbols** — Fast outline via tree-sitter
- **Code Folding** — Syntax-aware region folding
- **F# Support** — First-class F# via FSharp.Compiler.Service
- **Solution Explorer** — Tree view of your .sln/.slnx, projects, and symbols
- **Profiler** — Built-in .NET profiling, counter monitoring, and memory analysis

## Profiler

SharpLsp wraps `dotnet-trace`, `dotnet-counters`, and `dotnet-dump` into a seamless editor experience. No terminal required.

### Setup

Install the .NET diagnostic tools:

```bash
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-dump
```

### Usage

Open the **Profiler** panel in the SharpLsp sidebar to see running .NET processes.

| Action | How |
|--------|-----|
| **Trace performance** | `SharpLsp: Start Trace` — select a process, trace runs until you stop it. Output opens in SpeedScope. |
| **Monitor counters** | `SharpLsp: Start Counters` — live-updating table of .NET performance counters in a webview panel. |
| **Capture memory dump** | `SharpLsp: Collect Dump` — choose Heap, Full, or Mini dump type. |
| **Analyze heap** | `SharpLsp: Analyze Heap` — select a `.dmp` file to see type counts and memory usage. |

All commands are available from the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).

## Requirements

- .NET SDK 10.0+
- `sharplsp` binary (built from source or downloaded from releases)

## Configuration

Configure via `sharplsp.toml` in your workspace root. See the [full documentation](https://sharplsp.dev/docs/configuration/) for details.

## Links

- [Documentation](https://sharplsp.dev/docs/)
- [GitHub](https://github.com/Nimblesite/SharpLsp)
- [Issues](https://github.com/Nimblesite/SharpLsp/issues)
