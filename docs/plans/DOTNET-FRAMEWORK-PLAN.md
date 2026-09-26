# .NET Framework and Multi-Targeting Plan

Spec: [DOTNET-FRAMEWORK-SPEC.md](../specs/DOTNET-FRAMEWORK-SPEC.md).

## Verified on Windows (SDK 10.0.303, runtimes 8 + 10, .NET Framework 4.8.1)

- One C# project `net462;net472;net48;net8.0;net10.0` + F# `net48;net10.0` + `netstandard2.0`
  library: `dotnet test` builds, lists and runs every framework; VSTest 18.6 lists mixed
  .NET Framework/.NET assemblies in one call; TRX `codeBase` names each result's assembly.
- `dotnet test <sln> --framework net48` fails NETSDK1005 on projects without `net48`.
- F# design-time `FscCommandLineArgs` per framework: `net48` → `--targetprofile:mscorlib`, 4.8
  reference assemblies, `NETFRAMEWORK;NET48` (~1 s each).
- The three [NETFX-CORPUS] repos build on Windows in 23–54 s.

## TODO

- [x] Spec, research links, corpus selection
- [x] [NETFX-TEST-DISCOVERY] framework per banner, root description, `tfm:<tfm>` tags
- [x] [NETFX-TEST-RESULTS] codeBase → framework; one message per failing framework
- [x] [NETFX-TEST-PROFILES] `Run on <tfm>` profiles via `dotnet build` + `dotnet vstest`
- [x] [NETFX-DEBUG] Debug profile runs .NET frameworks only; .NET Framework-only refusal
- [x] [NETFX-TEST-MTP] .NET Framework MTP modules executed directly
- [x] [NETFX-PROJECTS-FSHARP] FCS options from the design-time compile, per framework
- [x] [NETFX-CONTEXT] active framework: sidecars, host requests + refreshes, VS Code status bar
- [x] Suites in [NETFX-TESTS]; Windows-only chunks registered in `test-chunks.json`
- [x] [NETFX-CORPUS] suites for GitReader, CsvHelper, NLog
