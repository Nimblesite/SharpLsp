# .NET Framework and Multi-Targeting `[NETFX]`

One project may target any mix of .NET Framework, .NET Standard and .NET, e.g.
`<TargetFrameworks>net462;net472;net48;net8.0;net9.0;net10.0</TargetFrameworks>`. Every feature
serves every framework it declares, in F# as in C#.

## Scope `[NETFX-SCOPE]`

| Target | Analyse | Build | Run / test | Debug |
|---|---|---|---|---|
| `net462`–`net481` | every OS | every OS: the SDK auto-references `Microsoft.NETFramework.ReferenceAssemblies` (`AutomaticallyUseReferenceAssemblyPackages`) | Windows only: the in-place 4.8.x CLR runs all of them | refused ([NETFX-DEBUG]) |
| `netstandard2.0`/`2.1` | every OS | every OS | never: a library | — |
| `net8.0`+ | every OS | every OS | needs that runtime | netcoredbg |

A framework whose runtime is absent (`net9.0` on a machine with only 8 and 10) is reported as
unrunnable by name, never as a failing or missing test.

## Project model `[NETFX-PROJECTS]`

**C#** `[NETFX-PROJECTS-CSHARP]`: `MSBuildWorkspace` yields one Roslyn project per framework,
named `Name(tfm)`, so a document has one context per framework. Every request answers from the
ACTIVE context ([NETFX-CONTEXT]).

**F#** `[NETFX-PROJECTS-FSHARP]`: FCS options come from the project's design-time compile, per
framework — never from the sidecar's own runtime:

```
dotnet msbuild <fsproj> -p:TargetFramework=<tfm> -p:DesignTimeBuild=true
  -p:SkipCompilerExecution=true -p:ProvideCommandLineArgs=true -p:BuildProjectReferences=false
  -p:NonExistentFile=__NonExistentSubDir__\__NonExistentFile__
  -t:ResolveAssemblyReferencesDesignTime;ResolveProjectReferencesDesignTime;
     ResolvePackageDependenciesDesignTime;FindReferenceAssembliesForReferences;
     _GenerateCompileDependencyCache;BeforeBuild;BeforeCompile;CoreCompile
  -getItem:FscCommandLineArgs
```

`net48` therefore compiles with `--targetprofile:mscorlib`, the 4.8 reference assemblies and
`NETFRAMEWORK;NET48;…_OR_GREATER`; source order, globs, conditions and `Directory.Build.*` are
MSBuild's. Relative arguments resolve against the project directory. If the design-time compile
fails, the project degrades to its `<Compile>` items against the sidecar runtime and the log says
why.

## Active framework `[NETFX-CONTEXT]`

- Default: the first entry of `<TargetFrameworks>`, as in Visual Studio.
- `sharplsp/targetFramework` `{ textDocument }` → `{ active, available }`;
  `sharplsp/setTargetFramework` `{ textDocument, targetFramework }` switches the whole PROJECT in
  both languages, then the server sends `workspace/diagnostic/refresh`,
  `workspace/semanticTokens/refresh` and `workspace/inlayHint/refresh`. A single-target project
  answers `available: []`.
- VS Code: a status-bar item shows the focused document's active framework when `available` has
  more than one entry; clicking it opens a quick pick. It follows the active editor reactively.

## Test Explorer `[NETFX-TEST]`

Extends [TEST-EXPLORER]; ids, filters and one-root-per-project are unchanged.

- `[NETFX-TEST-DISCOVERY]` Each `Test run for <dll> (<FrameworkName>)` banner names that
  assembly's framework (`.NETFramework,Version=v4.8` → `net48`,
  `.NETCoreApp,Version=v8.0` → `net8.0`). A project root's description lists its frameworks;
  each test carries a `framework:<tfm>` tag per framework whose assembly lists it.
- `[NETFX-TEST-RESULTS]` TRX `TestMethod/@codeBase` ties each result to its assembly, hence its
  framework. The merged outcome stays the worst row ([TEST-RUN-TRX]); a failure carries one
  message per failing framework, prefixed `[net48]`.
- `[NETFX-TEST-PROFILES]` One `Run on <tfm>` profile per discovered framework, scoped by its tag:
  `dotnet build <target>`, then `dotnet vstest <that framework's assemblies>
  [--TestCaseFilter:<expr>] --logger:trx --ResultsDirectory:<dir>`. Never
  `dotnet test <solution> --framework <tfm>`: every project lacking the framework fails NETSDK1005.
- `[NETFX-TEST-MTP]` A .NET Framework MTP module is executed directly — MSBuild's `TargetPath` is
  its `<Name>.exe`, where a .NET module's is its `.dll` — because `dotnet exec` cannot host the
  desktop CLR. Off Windows it is not spawned: "`<X>.exe` targets .NET Framework, which runs only
  on Windows". Under Debug it is skipped when a .NET module of the same project carries its
  tests, and refused otherwise ([NETFX-DEBUG]).

## Debug `[NETFX-DEBUG]`

netcoredbg cannot attach to the desktop CLR, so a test host waiting under `VSTEST_HOST_DEBUG=1`
would wait forever. The Debug profile runs only the selection's .NET frameworks; a selection
with none fails at once: "`<X>` runs on .NET Framework, and no .NET Framework debugger is
bundled: Debug attaches to .NET only. Use Run, or debug the test under one of its .NET target
frameworks." Run without debugging uses `dotnet run --framework <tfm>`.

## Real-world corpus `[NETFX-CORPUS]`

Windows-only chunk. Pinned commits, cloned at test time into `src/fixtures/real-world/`
(gitignored), `global.json` removed, `dotnet tool restore` for Paket repos.

| Repo @ commit | Lang | Test frameworks | Runner |
|---|---|---|---|
| JoshClose/CsvHelper @ `33970e5` | C# | `net462;net47;net48;net8.0;net9.0` | xUnit 2 |
| castleproject/Core @ `9631074` | C# | `net462;net8.0;net9.0;net10.0` | NUnit 3 |
| fsprojects/FSharpx.Extras @ `4a0378a` | F#, Paket | `net48;net8;net9;net10.0` | NUnit |
| haf/expecto @ `cec2c63` | F#, Paket | `net481;net10.0` | Expecto |

Each loads through the real extension; LSP answers inside `#if NETFRAMEWORK` code; discovery lists
.NET Framework assemblies; a run reports per-framework outcomes.

## Tests `[NETFX-TESTS]`

| Suite | Proves |
|---|---|
| `netfx-language.test.ts` | C#: default context, framework-only APIs, `#if` regions and diagnostics flip on switch; `netstandard2.0` reference from both families ([NETFX-PROJECTS-CSHARP], [NETFX-CONTEXT]) |
| `netfx-language-fsharp.test.ts` | the same for F#, against MSBuild's per-framework options ([NETFX-PROJECTS-FSHARP]) |
| `test-explorer-netfx.test.ts` | C# and F# across `net462;net472;net48` + installed .NET: tags, per-framework messages, `Run on <tfm>`, framework-exclusive tests, debug refusal ([NETFX-TEST], [NETFX-DEBUG]) |
| `test-explorer-mtp-netfx.test.ts` | MTP modules on `net48` + .NET, C# MSTest and F# `xunit.v3` ([NETFX-TEST-MTP]) |
| `real-repo-netfx-*.test.ts` | [NETFX-CORPUS] |

## References `[NETFX-REFERENCES]`

- [Target frameworks and preprocessor symbols](https://learn.microsoft.com/en-us/dotnet/standard/frameworks) · [.NET Standard](https://learn.microsoft.com/en-us/dotnet/standard/net-standard) · [Cross-platform targeting](https://learn.microsoft.com/en-us/dotnet/standard/library-guidance/cross-platform-targeting) · [NuGet TFMs](https://learn.microsoft.com/en-us/nuget/reference/target-frameworks)
- [SDK MSBuild properties](https://learn.microsoft.com/en-us/dotnet/core/project-sdk/msbuild-props) · [MSBuild CLI (`-getItem`, `-getProperty`)](https://learn.microsoft.com/en-us/visualstudio/msbuild/msbuild-command-line-reference) · [Directory.Build.*](https://learn.microsoft.com/en-us/visualstudio/msbuild/customize-by-directory) · [Design-time builds](https://github.com/dotnet/project-system/blob/main/docs/design-time-builds.md)
- [Reference assemblies packages](https://github.com/microsoft/dotnet/tree/main/releases/reference-assemblies) · [.NET Framework versions](https://learn.microsoft.com/en-us/dotnet/framework/migration-guide/versions-and-dependencies) · [Binding redirects](https://learn.microsoft.com/en-us/dotnet/framework/configure-apps/redirect-assembly-versions) · [packages.config](https://learn.microsoft.com/en-us/nuget/reference/packages-config)
- [MSBuildWorkspace](https://github.com/dotnet/roslyn/tree/main/src/Workspaces/MSBuild) · [MSBuildLocator](https://github.com/microsoft/MSBuildLocator) · [Finding MSBuild](https://learn.microsoft.com/en-us/visualstudio/msbuild/find-and-use-msbuild-versions) · [VS multi-targeting](https://learn.microsoft.com/en-us/visualstudio/ide/visual-studio-multi-targeting-overview) · [F# compiler options](https://learn.microsoft.com/en-us/dotnet/fsharp/language-reference/compiler-options)
- [`dotnet test`](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-test) · [`vstest.console` options](https://learn.microsoft.com/en-us/visualstudio/test/vstest-console-options) · [MTP](https://learn.microsoft.com/en-us/dotnet/core/testing/microsoft-testing-platform-intro) · [MTP vs VSTest](https://learn.microsoft.com/en-us/dotnet/core/testing/unit-testing-platform-vs-vstest) · [`dotnet run`](https://learn.microsoft.com/en-us/dotnet/core/tools/dotnet-run)
