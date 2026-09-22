# Test Explorer — Microsoft.Testing.Platform Plan

Implements [TEST-MTP-DETECT], [TEST-MTP-MODULES], [TEST-MTP-DISCOVERY], [TEST-MTP-RUN] and
[TEST-MTP-DEBUG] in `docs/specs/TEST-EXPLORER-SPEC.md`. Source issue: Nimblesite/SharpLsp#249.

## Why

The Test Explorer was VSTest end to end. Microsoft.Testing.Platform (MTP) projects got an
empty Testing view, because every VSTest command fails against them. On the .NET 10 SDK,
MTP v2 removed the VSTest shim and `xunit.v3` 4.0.0 uses MTP v2 by default, so this is now
the usual case, not an edge case.

## Measured behaviour

Recorded on this repo's SDK (10.0.303) against real probe projects. These measurements, not
documentation, decide the design.

| Package set | MTP version | `--list-tests json` | `--filter-uid` | `--report-trx` |
|---|---|---|---|---|
| `xunit.v3` 4.0.0 | 2.3.3 | yes | yes | needs `Microsoft.Testing.Extensions.TrxReport` |
| `MSTest` 4.4.0 | 2.x | yes | yes | built in |
| `NUnit` 4.4.0 + `NUnit3TestAdapter` 6.3.0 | 2.x | yes | yes | needs the TrxReport package |
| `MSTest` 3.11.0 | 1.9.0 | **no** — "expects no arguments" | yes | built in |

Facts that shaped the code:

* `dotnet vstest` loads an MSTest MTP module (it keeps a VSTest adapter) but CANNOT load an
  `xunit.v3` module. The `xunit.v3` case is the reported defect.
* The JSON listing carries a `type` block (`namespace`, `typeName`, `methodName`). The test
  id is built from it. MSTest's `displayName` is the bare method name, so a display name is
  never an id.
* The id built from `type` equals the `className` + `.` + `name` pair in the TRX report, for
  all three frameworks in both languages. The existing TRX reader needs no change.
* A data-driven test lists one node per row, each with its own uid, all sharing one `type`.
  Rows collapse onto one id that owns several uids.
* NUnit sends no `location`. xUnit and MSTest do.
* An unrecognized option exits with code 5 and prints `Unknown option '--x'`.
* `--no-progress` is deprecated in MTP 2.3 and warns on every run.
* MTP coverage writes `<guid>.cobertura.xml` directly into the results directory.
* `--debug` prints `Waiting for debugger to attach... Process Id: <pid>, Name: <name>`.
  The module is the test host; there is no `testhost.dll` child.

## Design

`dotnet test` is used for neither MTP discovery nor MTP runs. The test module is asked
directly with `dotnet exec`, which mirrors the two-pass VSTest path: build first, then ask
the built artifact.

| Step | VSTest path | MTP path |
|---|---|---|
| Build | `dotnet test --list-tests` | `dotnet build` |
| Modules | `Test run for …` banners | `dotnet sln list` + `-getProperty:TargetPath` |
| Names | `dotnet vstest --ListFullyQualifiedTests` | `dotnet exec … --list-tests json` |
| Selection | `--filter FullyQualifiedName=…` | `--filter-uid …` |
| Outcomes | `--logger trx` | `--report-trx` |

Everything after the TRX file is shared: `test-trx.ts`, the worst-row merge, the reporting
and the status lens.

## What the work found

Two defects that only a real fixture could show:

1. **NUnit refuses an F# selection.** The NUnit bridge translates `--filter-uid` back into a
   VSTest filter EXPRESSION and then rejects its own translation for any uid carrying a
   SPACE. The whole module then reported nothing, and four runnable F# tests showed as
   phantom failures. The remedy is the rule [TEST-FILTER-ESCAPE] already sets: re-run that
   module ONCE unfiltered and read the outcomes by name. A rejected OPTION earns no retry —
   it would be rejected again.
2. **MSTest 3.11 has no JSON listing.** It carries MTP 1.9.0, whose `--list-tests` takes no
   argument, and its text listing is bare method names. Current packages (MSTest 4.4.0,
   NUnit3TestAdapter 6.3.0, `xunit.v3` 4.0.0) all carry MTP 2.3 or later, so the fixtures pin
   those. A module on an older platform is reported with a warning naming the cause.

## TODO

- [x] Spec sections in `docs/specs/TEST-EXPLORER-SPEC.md`
- [x] This plan
- [x] `test-mtp.ts` — runner detection and the JSON listing reader (pure)
- [x] `test-mtp-modules.ts` — build, project list, MSBuild module resolution
- [x] `test-mtp-discovery.ts` — the `--list-tests json` sweep
- [x] `test-mtp-run.ts` — `--filter-uid` runs, per-module TRX, unfiltered retry
- [x] `test-trx-collect.ts` — the TRX collection both runners share
- [x] `test-batching.ts` — one command-line batcher for all three argument lists
- [x] `test-host-announce.ts` — the waiting-host pid reader, now pure and testable
- [x] `msbuild.ts` — `IsTestingPlatformApplication` property
- [x] `test-discovery.ts` — choose the runner, return the MTP plan
- [x] `test-execution.ts` / `testing.ts` — route a run to the MTP plan
- [x] `test-coverage.ts` — read Cobertura at both depths
- [x] `test-debug.ts` — MTP debug environment and prefixed pid line
- [x] MTP fixtures in `dotnet-project-kit.ts` and `test-explorer-mtp-fixtures.ts`
- [x] `test-explorer-mtp-parsers.test.ts`
- [x] `test-explorer-mtp.test.ts`
- [x] `test-explorer-mtp-outcomes.test.ts`
- [x] `test-chunks.json` — the new `testexplorer-mtp` chunk
- [x] `testing.ts` back under 500 lines (628 → 480)
- [ ] Deslop rescan — the CLI and the MCP server were not available in the session that did
      this work. The three command-line batchers were unified by hand into
      `test-batching.ts`; run `rescan` and `top-offenders` before merge.
- [x] Run the two new e2e suites in the real extension host.

## Verification run

`make _test-vsix-shard CHUNK=<chunk>` on Linux, against the real LSP host and both sidecars:

| Chunk | Result | Time |
|---|---|---|
| `testexplorer-mtp` (new) | 16 passing | 3 min |
| `testexplorer` | 113 passing | 8 min |
| `testexplorer-frameworks` | 51 passing | 5 min |
| `debug-tests` | 54 passing | 5 min |

The new chunk is well inside the 15-minute ceiling [DIST-CI-WIN-VSIX] sets. The other three
are the chunks this work touched, and none regressed.

The first host run found one more defect: the shared `assertFailed` helper hardcoded xUnit's
`Assert.Equal() Failure` text, which no MSTest or NUnit failure carries. It now takes the
framework's own text, defaulting to xUnit's so every existing caller is unchanged, and each
MTP fixture declares the text its framework writes.

## Not done

* **MTP server mode** (`--server jsonrpc`) is how Visual Studio and Rider talk to a module.
  It would give streaming results, cancellation and locations with no extension packages at
  all. The CLI path here is simpler and reuses the whole TRX pipeline. Revisit if the TRX
  extension requirement proves a burden for users.
