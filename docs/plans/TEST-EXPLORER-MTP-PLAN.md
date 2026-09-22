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
| `xunit.v3` 4.0.0 | 2.3.3 | yes | yes | optional extension; built-in `--report-xunit-trx` also works |
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
* Except with `--report-trx`. `Microsoft.Testing.Extensions.TrxReport` 2.4.0 then runs the module
  as a test host CONTROLLER that launches the real host as a child. The child gets the parent's
  whole environment and command line, so under `TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1` (or
  `--debug`) BOTH processes wait for a debugger. Measured by attaching netcoredbg to the first
  process: the second line `Waiting for debugger to attach... Process Id: <child>` follows it.

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
- [x] `test-explorer-mtp-modules.test.ts` — failing tests for three run defects found in
      review, committed before any fix: a stale module, a TRX collision, a lost failure
- [x] Build the target before every MTP run. `dotnet exec` builds nothing, so an edited test
      ran from its stale module and reported its OLD outcome.
- [x] Number TRX reports across the whole run, not per module. The two target frameworks of
      one project share a module file name, so the second report overwrote the first and a
      test failing on one framework only showed as passed.
- [x] Keep every module's failure when merging ACROSS modules. A sibling's results erased the
      message naming `Microsoft.Testing.Extensions.TrxReport`.
- [x] Failing tests for the review's regressions and remaining defects, each confirmed red
      against the code before its fix: `multiroot/test-explorer-mixed-runners.test.ts`,
      `test-explorer-mtp-sweeps.test.ts`, `test-explorer-mtp-batches.test.ts`, and a decoy-line
      case in `test-explorer-mtp-parsers.test.ts`
- [x] A second editor start for multi-root suites (`.vscode-test.mjs`, `src/test/suite/index.ts`,
      [DIST-CI-VSIX-SHARDS]) and the `testexplorer-mtp-runners` chunk
- [x] Route each test to the runner that discovered it ([TEST-MTP-ROUTING],
      `test-run-routes.ts`). One MTP folder in a multi-root workspace sent EVERY run to MTP, so
      the VSTest folder's tests all reported "No result reported".
- [x] Rebuild each module from its OWN discovery target. The run's working directory is the
      first workspace folder, so an MTP module in the second folder ran stale.
- [x] The probe after the VSTest passes evaluates first and builds only an MTP project. A
      library solution and a VSTest solution that failed to build were built twice per sweep.
      Each project is evaluated once, not twice.
- [x] Resolve a folder or a project file the way `dotnet` does. Walking the folder listed
      modules an earlier build had left on disk; an opted-in folder `dotnet` refuses is now an
      error row, not an empty tree.
- [x] Replace the run plan only when the tree is replaced. A sweep whose modules failed to list
      kept the tree but swapped in an empty plan.
- [x] Keep a refused batch's failure beside an accepted batch of the same module, so the
      refusal is retried.
- [x] Anchor the pid reader to the two real announcements. A test printing "Process Id: N"
      mid-line aimed the debugger at N.
- [x] Name `Microsoft.Testing.Extensions.CodeCoverage` when a module rejects `--coverage`.
- [x] [TEST-MTP-DEBUG] describes `TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER`, which is what the code
      sets; it never passed `--debug`.
- [x] `test-explorer-mtp-merges.test.ts` — the merge, routing, runner, Cobertura-depth and
      folder-resolution rules at their own boundary
- [x] `invoke`, `runModule`, `listTests` and `listMtpTests` split under 20 lines
- [x] Read MTP's arity refusal — `Option '--list-tests' from provider … expects no arguments` —
      as a rejected option ([TEST-MTP-DISCOVERY]). MSTest 3.11 printed it, not `Unknown option`,
      so its "older than 2.3" warning never appeared. Red first in the parser and sweep suites.
- [x] Run a sweep AND apply its result as ONE queued job ([TEST-REACTIVITY]). A run queued
      behind a sweep started before the sweep's runners were applied, so it went to the runners
      of the sweep before: a project just moved onto MTP went to `dotnet test`, and the MTP Debug
      profile left its module waiting for a debugger forever. Red first in
      `test-explorer-mtp-queue.test.ts` and `debug-test-mtp-e2e.test.ts`.
- [x] Debug an MTP module WITHOUT `--report-trx` ([TEST-MTP-DEBUG]). The TRX host controller
      waited for the debugger too, so the Debug profile attached a second session to a process
      that runs no test. That debug run reports no per-test verdict and never retries unfiltered.
      Red first in `debug-test-mtp-e2e.test.ts` ("ONE selection is ONE session").
- [x] A refresh superseded by a newer sweep resolves only once the NEWEST sweep has applied
      ([TEST-REACTIVITY], `NewestJob` in `test-queue.ts`). It returned over the previous
      solution's tree. Red first in the second test of `test-explorer-mtp-queue.test.ts`.
- [x] At least five more spec-derived assertions on every test written or changed in this
      review round (the frozen `test-explorer-mtp-modules.test.ts` is untouched)
- [x] F# parity for every single-module C# case: `test-explorer-mtp-fsharp.test.ts`
      (multi-targeted F# module, edit then ▶, VSTest → MTP migration in place) and
      `debug-test-mtp-fsharp-e2e.test.ts` (backtick names, theory rows, at-cursor), in the new
      `testexplorer-mtp-parity` chunk
- [x] Re-list each rebuilt module before a filtered run and select by ITS uids
      ([TEST-MTP-RUN], `relistModule`). `xunit.v3` hashes a row's data into its uid and MSTest
      keys rows by position, so an edited or added row was skipped and a red row reported
      green. Red first in `test-explorer-mtp-fsharp.test.ts` and `test-explorer-mtp-rows.test.ts`.

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

Release regression follow-through ([TEST-MTP-RUN]):

- [x] Reproduce bare xUnit v3 execution failure with real F# and C# projects before fixing it.
- [x] Negotiate xUnit's built-in reporter after the optional MTP reporter is rejected.
- [x] Verify pass/fail/skip, theory attribution, individual selection, and CodeLens without an extra package.
- [x] Preserve missing-reporter diagnostics using real F# and C# NUnit projects with neither reporter.
- [ ] Complete the MTP regression chunks against the final release candidate on supported platforms.

* **MTP server mode** (`--server jsonrpc`) is how Visual Studio and Rider talk to a module.
  It would give streaming results, cancellation and locations with no extension packages at
  all. The CLI path here is simpler and reuses the whole TRX pipeline. Revisit if the TRX
  extension requirement proves a burden for users.
