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

### C# `[NETFX-PROJECTS-CSHARP]`

`MSBuildWorkspace` yields one Roslyn project per framework,
named `Name(tfm)`, so a document has one context per framework. Every request answers from the
ACTIVE context ([NETFX-CONTEXT]).

### F# `[NETFX-PROJECTS-FSHARP]`

FCS options come from the project's design-time compile, per
framework — never from the sidecar's own runtime:

```
dotnet msbuild <fsproj> -p:TargetFramework=<tfm> -p:DesignTimeBuild=true
  -p:SkipCompilerExecution=true -p:ProvideCommandLineArgs=true -p:BuildProjectReferences=false
  -p:NonExistentFile=__NonExistentSubDir__\__NonExistentFile__
  -t:ResolveAssemblyReferencesDesignTime;ResolveProjectReferencesDesignTime;
     ResolvePackageDependenciesDesignTime;FindReferenceAssembliesForReferences;
     _GenerateCompileDependencyCache;BeforeBuild;BeforeCompile;CoreCompile
  -getItem:FscCommandLineArgs -getItem:ReferencePathWithRefAssemblies
```

`net48` therefore compiles with `--targetprofile:mscorlib`, the 4.8 reference assemblies and
`NETFRAMEWORK;NET48;…_OR_GREATER` (about 1 s per framework on SDK 10.0.303); source order, globs, conditions and `Directory.Build.*` are
MSBuild's. Relative arguments resolve against the project directory. If the design-time compile
fails, the project degrades to its `<Compile>` items against the sidecar runtime and the log says
why. Every `.fsproj` of the solution loads and a file answers from the project that compiles it;
the first is the workspace's for project-wide queries. MSBuild is asked only when the project
file declares `<TargetFrameworks>` and evaluates to two or more: the first framework's options
are built at load, each other's on its first switch, then kept. A single-target project keeps
its `<Compile>` items. Each project reference MSBuild resolved names the framework of the
referenced project it picked, and an F# one is read in memory from that framework's options,
built at load or at the switch that needs them
([SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-REFERENCES]).

## Active framework `[NETFX-CONTEXT]`

- Default: the first entry of `<TargetFrameworks>`, as in Visual Studio.
- `sharplsp/targetFramework` `{ textDocument }` → `{ active, available, project }`;
  `sharplsp/setTargetFramework` `{ textDocument, targetFramework }` switches the whole PROJECT in
  both languages and answers the same shape. A single-target project answers
  `{ active: null, available: [] }`; a document no loaded project compiles answers
  `{ active: null, available: [], project: null }`, and switching it is an error.
- After a switch the host clears its navigation cache, re-publishes every open document's
  diagnostics, sends `sharplsp/targetFrameworkChanged` `{ textDocument, active, available,
  project }`, then each of `workspace/semanticTokens/refresh`, `workspace/inlayHint/refresh`,
  `workspace/codeLens/refresh` and `workspace/diagnostic/refresh` whose `refreshSupport` the
  client declared.
- VS Code: a status-bar item `$(versions) <tfm>` shows the focused document's active framework
  when its project is multi-targeted, and runs `sharplsp.selectTargetFramework [tfm]`. Without
  an argument the command opens a pick placeheld `Target framework for <Project>` (file name, no
  extension) listing `available` in order, the active one described `active` and pre-picked.
  The item re-reads on active-editor change, on `sharplsp/targetFrameworkChanged`, and while the
  workspace is still loading; the extension API exposes it live as
  `targetFrameworkStatus { item, visible, active, available }`.

## Test Explorer `[NETFX-TEST]`

Extends [TEST-EXPLORER]; ids, filters and one-root-per-project are unchanged.

### Discovery `[NETFX-TEST-DISCOVERY]`

Each `Test run for <dll> (<FrameworkName>)` banner names that
  assembly's framework (`.NETFramework,Version=v4.8` → `net48`,
  `.NETCoreApp,Version=v8.0` → `net8.0`). For a MULTI-targeted project only, the root's
  description joins its frameworks with ` · `, a build that listed nothing reading
  `<tfm> (nothing listed)`, and each test carries a `tfm:<tfm>` tag per framework whose assembly
  lists it. A single-target project's rows are unchanged. A framework whose run wrote no result
  logs `Test run: <tfm> reported no result`.

### Results `[NETFX-TEST-RESULTS]`

TRX `TestMethod/@codeBase` ties each result to its assembly, hence its
  framework. The merged outcome stays the worst row ([TEST-RUN-TRX]); a failure carries one
  message per failing framework, prefixed `[net48]`.

### Run profiles `[NETFX-TEST-PROFILES]`

One `Run on <tfm>` profile per discovered framework, scoped by its tag:
  `dotnet build <target>`, then `dotnet vstest <that framework's assemblies>
  [--TestCaseFilter:<expr>] --logger:trx --ResultsDirectory:<dir>`. Never
  `dotnet test <solution> --framework <tfm>`: every project lacking the framework fails NETSDK1005.

### MTP modules `[NETFX-TEST-MTP]`

A .NET Framework MTP module is executed directly — MSBuild's `TargetPath` is
  its `<Name>.exe`, where a .NET module's is its `.dll` — because `dotnet exec` cannot host the
  desktop CLR. Off Windows it is not spawned: "`<X>.exe` targets .NET Framework, which runs only
  on Windows". Under Debug only .NET modules start: a .NET Framework module is refused when a
  selected test it carries has no .NET module, and left out otherwise ([NETFX-DEBUG]).

## Debug `[NETFX-DEBUG]`

netcoredbg cannot attach to the desktop CLR, so a test host waiting under `VSTEST_HOST_DEBUG=1`
would wait forever. The Debug profile runs only the selection's .NET frameworks; a selection
with none fails at once: "`<X>` runs on .NET Framework, and no .NET Framework debugger is
bundled: Debug attaches to .NET only. Use Run, or debug the test under one of its .NET target
frameworks." `<X>` is the project (its assembly name) for VSTest and `<Name>.exe` for MTP; each
refusal is logged exactly once, on one `Test debug:` line.

Run without debugging (`sharplsp.runProgram`, Ctrl+F5) of a MULTI-targeted project runs the
task `Run <Project> (<tfm>)` (type `sharplsp-run`): `dotnet run --project <proj> --framework
<tfm> [-- <profile args>]`, with no debug adapter, so a .NET Framework build runs on the desktop
CLR. `<tfm>` is the project's active framework ([NETFX-CONTEXT]) when launched from one of its
documents, else its first declared; the channel logs `Run: <Project> under <tfm>`. Debug (F5)
of a multi-targeted project debugs its active framework when that is .NET, else the first .NET
framework it declares, and refuses with the message above when it declares none. A
single-target project runs and debugs as before.

## Real-world corpus `[NETFX-CORPUS]`

Windows-only chunk. Every repo targets several .NET Framework AND several .NET Standard versions,
and builds on Windows in 23–54 s.
Pinned commits, cloned at test time into `src/fixtures/real-world/` (gitignored), `global.json` removed.
`src/fixtures/` ends the `Directory.Build.*` and `.editorconfig` lookups, so each repo builds under its
own configuration, never SharpLsp's.

| Repo @ commit | Lang | Library frameworks | Test frameworks | Runner |
|---|---|---|---|---|
| kekyo/GitReader @ `079ea85` | F#, C# (F# + C# tests) | F#: `net461;net462;net48;net481;netstandard2.0;netstandard2.1`+.NET · C#: `net35`..`net481` (7), `netstandard1.6;2.0;2.1` | `net48;net8.0;net9.0;net10.0` | NUnit 4 |
| JoshClose/CsvHelper @ `33970e5` | C# | `net462;net47;net48;netstandard2.0;2.1;net8.0;net9.0` | `net462;net47;net48;net8.0;net9.0` | xUnit 2 |
| NLog/NLog @ `73c7945` (`src/NLog.sln`) | C# | `net35;net46;netstandard2.0;netstandard2.1` | `net462;net10.0` | xUnit 2 |

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
