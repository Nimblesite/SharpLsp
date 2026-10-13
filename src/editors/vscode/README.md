<p align="center">
  <img src="https://sharplsp.dev/assets/images/marketplace/sharplsp-tour.gif" width="100%" alt="SharpLsp tour: the open-source alternative to Visual Studio and Rider — Solution Explorer, NuGet browser, C# and F#, debugging, profiling and testing in VS Code, Cursor and Windsurf">
</p>

<h1 align="center">SharpLsp</h1>

<p align="center">
  <strong>The open-source alternative to Visual Studio and Rider.</strong><br>
  Full C# and F# — NuGet, debugging, profiling and testing — in the editor you already use.
</p>

<p align="center">
  <a href="https://sharplsp.dev/docs/">Docs</a> ·
  <a href="https://sharplsp.dev/blog/">Blog</a> ·
  <a href="https://github.com/Nimblesite/SharpLsp">GitHub</a> ·
  <a href="https://github.com/Nimblesite/SharpLsp/issues">Issues</a> ·
  <a href="https://sharplsp.dev/ja/">日本語</a> ·
  <a href="https://sharplsp.dev/zh/">简体中文</a>
</p>

## 🥊 Ditch the heavyweight IDE. Keep the power.

Solution Explorer, project and package references, build, refactoring, NuGet, a debugger, a profiler and a Test Explorer — the whole IDE workflow, inside VS Code. **No subscription. No license server. No account. MIT, forever.**

<p align="center">
  <img src="https://sharplsp.dev/assets/images/marketplace/sharplsp-explorer.png" width="100%" alt="SharpLsp Solution Explorer showing a .NET solution, projects, dependencies and C# symbols next to Roslyn-highlighted code">
</p>

## ⚖️ C# and F#. No favorites.

C# runs on **Roslyn**. F# runs on **FSharp.Compiler.Service**. Both get completions, hover, go to definition, references, rename, code actions, semantic highlighting, inlay hints and live diagnostics — and both get the same Solution Explorer, Test Explorer, debugger and profiler.

F# extras: **F# Interactive**, `.fsi` signature generation and pipeline type hints.

## 🐞 Debug, profile, test. All the good stuff.

| | |
| --- | --- |
| 🐞 **Debug** | F5, breakpoints, stepping and Hot Reload. The MIT-licensed netcoredbg debugger ships in the box. |
| 🔥 **Profile** | CPU traces in SpeedScope, live counters, memory dumps, heap diffs, leak detection and retention graphs. |
| 🧪 **Test** | Test Explorer and CodeLens for xUnit, NUnit, MSTest, Expecto and FsCheck — VSTest and MTP, C# and F#. |
| 📦 **NuGet** | Browse, install, update, remove and consolidate packages. No terminal. |

<p align="center">
  <img src="https://sharplsp.dev/assets/images/marketplace/sharplsp-nuget.png" width="100%" alt="SharpLsp NuGet browser listing packages with download counts and a package details panel with an Install button">
</p>

## 🌍 Runs everywhere.

**Windows and Linux** (x64 and Arm64) and **macOS** (Apple silicon). Install from the VS Code Marketplace or **Open VSX** — **VS Code, Cursor, Windsurf, VSCodium** and the rest of the family. The debugger is open source too, so F5 works in every one of them.

## ⚡ Get started in 30 seconds

1. Install **SharpLsp**.
2. Open a folder containing a `.sln`, `.slnx`, `.csproj` or `.fsproj`.
3. Code.

The extension bundles the language server, both .NET sidecars and the debugger, and fetches the **.NET 10 SDK** through Microsoft's .NET Install Tool if you don't have one. The profiler drives the standard .NET diagnostic tools — install them once:

```bash
dotnet tool install -g dotnet-trace
dotnet tool install -g dotnet-counters
dotnet tool install -g dotnet-dump
```

Tune everything with a `sharplsp.toml` in your workspace — see the [configuration guide](https://sharplsp.dev/docs/configuration/).

## 💚 Open source

SharpLsp is built in the open on [GitHub](https://github.com/Nimblesite/SharpLsp) under the MIT license. Bugs, ideas and pull requests are welcome.
