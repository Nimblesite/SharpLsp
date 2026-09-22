# Review: PR #250, Microsoft.Testing.Platform in the Test Explorer

Branch `mtp-test-explorer` against `main` (merge-base at `03b4b01e`), reviewed 2026-09-22.
Scope: regressions for existing VSTest users, defects in the new MTP path, and gaps in end-to-end (E2E) test coverage.

## Verdict

**Not ready to merge.** Two changes regress existing users. Three defects in the new MTP path give wrong or misleading results. The E2E suites cover discovery and plain runs well. They do not cover Debug, Run with Coverage, edit-then-run, multi-targeting, mixed runners, or the path with no `global.json` opt-in, which is how issue #249 was reported. **CI has never run on this branch.**

## What was verified

| Check | Result |
|---|---|
| `prettier --check`, `eslint src/`, `tsc --noEmit` | **Pass** (run locally) |
| PR CI | **Never ran.** All three workflow runs on the branch (`PR`, `CodeQL`, `Dependabot auto-merge`) are `action_required`, meaning they are waiting for approval. The Windows matrix ([DIST-CI-WIN-VSIX]) has never run this code. |
| E2E chunks (`testexplorer-mtp`, `testexplorer`, `testexplorer-frameworks`, `debug-tests`) | **Not run here.** `global.json` pins SDK 10.0.303, and this machine has 10.0.203 and 9.0.312. The pass counts in the plan (16 / 113 / 51 / 54) come from one local Linux run, and CI has not confirmed them. |
| Code moved out of `testing.ts` (`test-items`, `test-profiles`, `test-queue`, `test-result-cache`, `test-trx-collect`, `test-listing-model`, `test-batching`, `isRecord`) | Compared line by line. **VSTest behaviour is identical.** The batching cost functions are unchanged (`assembly.length + 3`, `filterClause(name).length + 1`). The VSTest path passes `locations: undefined`, so its row URIs and ranges are unchanged. |
| File size < 500 LOC | Pass. `dap-hot-reload.ts` is 547 lines, but it was over the limit before this branch and got 4 lines shorter. |
| Function size < 20 LOC | New or grown functions over the limit: `invoke` (31 lines, [test-mtp-run.ts:133](../../src/editors/vscode/src/test-mtp-run.ts#L133)), `listTests` (24), `runModule` (22), `listMtpTests` (22). |
| Deslop duplication rescan | Not done. The plan's own TODO leaves it open, and the Deslop MCP server failed to connect in this session. |

---

## Regressions for existing users

### R1. In a multi-root workspace, one MTP folder takes over every run (Medium-High) — **FIXED**

> Failing test first: `multiroot/test-explorer-mixed-runners.test.ts` (a new two-folder editor start). On the old code the VSTest folder's tests reported "No result reported … (filter matched no test)" from a selection, the whole tree and the status lens. Fix: `test-run-routes.ts` sends each id to the runner that discovered it and merges both outcomes, keeping failures ([TEST-MTP-ROUTING]). The same suite caught a multi-root flaw in the B1 fix, which rebuilt the first folder: modules now carry and rebuild their own discovery target.

`mtpPlan` is a single field for the whole controller ([testing.ts:80](../../src/editors/vscode/src/testing.ts#L80)), set from every target in the sweep ([testing.ts:212](../../src/editors/vscode/src/testing.ts#L212)). `dispatch()` sends **every** run to `runMtpTests` whenever that field is set ([testing.ts:346](../../src/editors/vscode/src/testing.ts#L346)).

With no solution loaded, `discoveryTargets()` returns each workspace folder. Take folder A with VSTest (xUnit v2) and folder B with MTP (xunit.v3):

- ▶ on an A test: no MTP module owns its id, so every module counts as `untouched` and nothing starts. The test reports `No result reported for … (filter matched no test)`.
- ▶ on the root: only B's modules run. Every A test comes back errored.
- The status CodeLens (`runTest` → `runOne`) and the Debug profile go through the same `dispatch` and fail the same way.

On `main`, A's tests ran whenever A was the first folder, which is the one `runCwd()` picks. They no longer run. **No test covers mixed runners.**

### R2. Extra cost whenever VSTest finds no tests (Medium, performance) — **FIXED**

> Failing test first: `test-explorer-mtp-sweeps.test.ts` counts builds through a real `Directory.Build.props`. On the old code, the probe built a library solution VSTest never built. Fix: after the VSTest passes, the probe evaluates first and builds only when a project IS an MTP module; each project is evaluated once. A library solution and a VSTest solution that fails to build now cost exactly the VSTest builds. The probe still runs `dotnet sln list` plus one evaluation per project.

The MSBuild probe runs whenever the VSTest passes attribute no assembly ([test-discovery.ts:184-185](../../src/editors/vscode/src/test-discovery.ts#L184-L185)). That happens in three cases:

- a solution with **no test projects** (a library solution with the Testing view open);
- a VSTest solution that **fails to build**;
- the display-name fallback case.

Each sweep then also runs `dotnet build` again, then `dotnet sln list`, then one `dotnet msbuild -getProperty` per project. MTP projects are evaluated twice, because `modulesOf` re-evaluates what `scanProject` has just evaluated ([test-mtp-modules.ts:109](../../src/editors/vscode/src/test-mtp-modules.ts#L109) and [:124](../../src/editors/vscode/src/test-mtp-modules.ts#L124)). All of this runs serially while holding the `dotnet` queue, so a ▶ waits behind it. Each step gets its own full timeout. In the build-error case, the error row now appears only after a **second** failing build.

The spec's claim that "this order costs a VSTest solution nothing" ([TEST-MTP-DETECT]) holds only when VSTest found tests. No test covers this case and it was not measured.

### R3. The pid reader is no longer anchored to the start of the line (Low) — **FIXED**

> Failing test first: the decoy-line case in `test-explorer-mtp-parsers.test.ts`; `Test output: Process Id: 1234, …` returned 1234. Fix: only the two real announcements are accepted, each at the start of the line.

`announcedTestHostPid` now matches `Process Id:` **anywhere** in a line ([test-host-announce.ts:45](../../src/editors/vscode/src/test-host-announce.ts#L45)). During a VSTest Debug run, all test output is scanned. A test or logger that prints `… Process Id: 1234, …` would make the debugger attach to that pid. The parser tests cover the bare and prefixed forms, but include no decoy line.

---

## Defects in the new MTP path

### B1. MTP runs use stale binaries because nothing builds before `dotnet exec` (High) — **FIXED**

> Failing test committed in `2ca5c2ab` (`test-explorer-mtp-modules.test.ts`, "an edited test is REBUILT…"): the edited test reported `passed`. Fix: `runMtpTests` runs `dotnet build <target>` first; a failed build fails the run.

The VSTest path runs `dotnet test` without `--no-build`, so every ▶ rebuilds. The MTP path calls `dotnet exec <module.dll>` straight away ([test-mtp-run.ts:150](../../src/editors/vscode/src/test-mtp-run.ts#L150)) and never builds. The only build happens during discovery, and discovery runs only on solution change, on activation, or on a manual refresh. It does not run on save.

**Repro:** discover an MTP solution, change an assertion so a passing test fails, save, then press ▶. The old binary runs and reports a **pass**. That false green is cached and painted by the status CodeLens. The Debug profile debugs the same stale module, so breakpoints on edited lines bind to old code. The comment in [test-queue.ts](../../src/editors/vscode/src/test-queue.ts) ("a run rebuilds the same projects") is also no longer true for MTP runs.

**No test edits source between discovery and a run.**

### B2. In a multi-targeted MTP project, the second target framework's results are dropped, which can report a false pass (High, narrow) — **CONFIRMED, FIXED**

> Failing test committed in `2ca5c2ab`: ▶ on the whole tree reported `Fails_Only_On_NET10_0` as `passed`. This confirms MTP overwrites an explicitly named report. Fix: TRX names are numbered across the whole run, not per module.

`trxNameFor` produces `<stem>.<batchIndex>.trx` ([test-mtp-run.ts:62-65](../../src/editors/vscode/src/test-mtp-run.ts#L62-L65)). Both target frameworks of one project build a module with the same stem (`bin/Debug/net8.0/Foo.dll` and `bin/Debug/net9.0/Foo.dll`), so both write `Foo.0.trx` into the shared results directory. When the second module runs, `Foo.0.trx` is already in its `before` set, so `collectReport` skips it.

I believe MTP overwrites an explicitly named report; I did not confirm that against the TrxReport source. If it does:

- **▶ on the root** (no ids, so no retry): a test that fails only on net9.0 shows as **passed**, using net8.0's result. The second module's non-zero exit is also cleared by `mergeOutcomes` (see B3).
- **A selection:** the second module's failure triggers an unnecessary unfiltered retry of the whole module, which writes `Foo.1.trx` and recovers the result, but slowly.

[TEST-MTP-MODULES] calls out multi-targeting, and [TEST-MTP-RUN] says per-module names exist to prevent exactly this overwrite. **No fixture is multi-targeted.** Suggested fix: make the name unique per module path, for example by adding the module index or a short hash of `modulePath`.

### B3. One module's failure message is lost when another module reported results (Medium) — **FIXED**

> Failing test committed in `2ca5c2ab`: the no-TrxReport project's test showed "No result reported … (filter matched no test)". Fix: failures are kept when merging ACROSS modules; within one module the old rule (results clear the failure) still drives the retry.

`mergeOutcomes` sets `failure: results.size > 0 ? undefined : …` ([test-mtp-run.ts:207](../../src/editors/vscode/src/test-mtp-run.ts#L207)). Consider a solution where module A references TrxReport and module B does not. On ▶, A reports results, so B's message ("Add a PackageReference to Microsoft.Testing.Extensions.TrxReport…") is discarded. B's tests show `No result reported … (filter matched no test)`, which is the silent failure that [TEST-MTP-RUN] says **MUST NOT** happen. The same applies to a module that crashes or is missing on disk.

The E2E test for the missing extension ([test-explorer-mtp-outcomes.test.ts:279](../../src/editors/vscode/src/test/suite/test-explorer-mtp-outcomes.test.ts#L279)) uses a **single-module** solution, so it cannot catch this. Suggested fix: keep failures per module and report each missing test with its own module's failure.

### B4. A failed sweep replaces the run plan but keeps the old tree (Low-Medium) — **FIXED**

> Failing test first: `test-explorer-mtp-sweeps.test.ts`, with a module initializer that exits while a marker file exists. After a failed re-sweep, ▶ on the kept tree reported "No result reported". Fix: the run map changes only when the tree does.

`this.mtpPlan` is assigned before `applyDiscovery` ([testing.ts:212-213](../../src/editors/vscode/src/testing.ts#L212-L213)). `applyDiscovery` deliberately keeps the previous tree when nothing could be enumerated. If every MTP module fails to list, for example because of a transient file lock, `listMtpTests` still returns a plan whose modules have empty `uidsById` maps ([test-mtp-discovery.ts:151](../../src/editors/vscode/src/test-mtp-discovery.ts#L151)). Every test in the kept tree then reports "No result reported". Suggested fix: replace the plan only when the tree is replaced.

### B5. Directory and project-file targets can list stale modules (Low) — **FIXED**

> Failing test first: `test-explorer-mtp-sweeps.test.ts`, where a two-project folder listed a stale module's test. Fix: a folder is the ONE project or solution file directly in it, and a project file is only itself, the way `dotnet` resolves them. A folder `dotnet` refuses (MSB1011/MSB1003) is an error row, including under the `global.json` opt-in, never an empty tree.

With no solution loaded, `projectsOf` walks up to 6 directory levels for every `*.csproj`/`*.fsproj` ([test-mtp-modules.ts:92-99](../../src/editors/vscode/src/test-mtp-modules.ts#L92-L99)). Meanwhile `dotnet build <folder>` fails with MSB1011 if the folder holds more than one project or solution. That failure is only a warning, so modules left on disk by **earlier** builds are listed and run. A project-file target also picks up sibling projects under its directory. **All E2E tests load a `.sln`, so this path is untested.**

### B6. A refusal in a later uid batch is never retried (Low) — **FIXED**

> Failing test first: `test-explorer-mtp-batches.test.ts`, an F# NUnit module of 150 long-named tests plus a spaced `[<TestCase>]` in the last batch; the retry never ran. Fix: batches keep each other's failures, as modules do, and only the unfiltered retry replaces a failure.

Within one module, `mergeOutcomes` clears `failure` once any batch produced results. If a module's uids span more than one batch (over roughly 24,000 characters) and only the batch holding a space-named NUnit uid is refused, `needsUnfilteredRetry` sees no failure and those tests show phantom errors.

### B7. The debug spec and the code disagree (Doc) — **FIXED**

> [TEST-MTP-DEBUG] now describes `TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1` and the anchored pid reader.

[TEST-MTP-DEBUG] says "`--debug` makes the module print …". The code never passes `--debug`. It sets `TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1` instead ([test-debug.ts:49](../../src/editors/vscode/src/test-debug.ts#L49)). The spec should describe what the code does.

### B8. A module on MTP older than 2.3 never gets its "update the package" warning (Medium) — **FOUND LATER, FIXED**

> Found while closing coverage gap #10. MTP 1.9 (MSTest 3.11) does not print `Unknown option '…'` for `--list-tests json`. Verified against a real module, it prints `Option '--list-tests' from provider … expects no arguments` and exits 5. `rejectedMtpOption` only read the first form, so the promised warning never appeared, and the module just "listed no test". Failing tests first: the verbatim line in `test-explorer-mtp-parsers.test.ts`, and a real MSTest 3.11 module in `test-explorer-mtp-sweeps.test.ts`. Both were red on the old code for exactly that reason: the reader returned `undefined`, and the module "listed no test: dotnet exited with code 5". The fix is in `test-mtp.ts`: a line that STARTS `Option '<name>'` and says what it `expects` names the refused option, the same way `Unknown option` does ([TEST-MTP-DISCOVERY]).

### B9. A run queued behind a discovery sweep goes to the runner the sweep before it found (High for MTP Debug) — **FOUND LATER, FIXED**

> Found through the new MTP Debug suite, which hung. Its `dotnet test --filter … --logger trx` process was still running against the MTP fixture 18 minutes later. That is the VSTest command: in MTP mode the SDK passed it on to the module, which sat waiting for a debugger that never attached. Every `dotnet` call goes through one queue ([TEST-REACTIVITY]), but a sweep applied its tree and runners only AFTER the queue had started the next job. So a run pressed while a sweep was listing always used the runners from BEFORE that sweep. Moving a project onto MTP and pressing ▶ during the refresh reported "dotnet exited with code 5". Pressing Debug hung the Testing view's queue until the process was killed, which also stalled every Test Explorer suite after it in the same run.
>
> Failing test first: `test-explorer-mtp-queue.test.ts` moves one project from VSTest onto MTP in place and presses ▶ while the refresh is still queued. On the old code it failed with `got 'notRun': dotnet exited with code 5`. The fix is in `testing.ts`: listing every target AND applying the result are now ONE queued job, so the job behind it starts only after the runners are in place. The spec records this under [TEST-REACTIVITY].

### B10. The MTP Debug profile attaches a second session to a process that runs no test (High for MTP Debug) — **FOUND LATER, FIXED**

> Found once B9 was fixed and the MTP Debug suite reached the module. Every debug run announced TWO waiting pids. `--report-trx` makes `Microsoft.Testing.Extensions.TrxReport` 2.4.0 run the module as a test host CONTROLLER that launches the real host as a child. The decompiled `TestHostControllersTestHost` shows it hands the child its whole environment and command line. So under `TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER=1` (and under `--debug`) both processes wait. Verified by attaching netcoredbg to the first process: a second `Waiting for debugger to attach... Process Id: <child>` follows. Without `--report-trx` the module is one process. The Debug profile attached a session to each, so "ONE selection is ONE session" failed, and the first session could not even produce a stack trace (`Failed command 'stackTrace' : 0x80070057`).
>
> Fixed in `test-mtp-run.ts`: a Debug-profile run (`TestRunOptions.debug`) passes no `--report-trx`. Its exit code is no verdict, and it never retries unfiltered. `reportDebugOutcome` leaves its MTP tests without a verdict instead of painting "No result reported". The rule is in [TEST-MTP-DEBUG].

### B11. A refresh superseded by a newer sweep resolves over the previous solution's tree (Medium) — **FOUND LATER, FIXED**

> Found in a combined run, where the adapter-ids suite saw the MTP Debug suite's tree. After a solution change, `activateAndDiscover()` started a sweep that the debounced sweep then superseded. The superseded sweep applied nothing, and the caller's `await` ended anyway, so the refresh returned with the OLD solution's tree on view. Failing test first: the second test in `test-explorer-mtp-queue.test.ts`, red at "the new tree". Fixed in `testing.ts` and `test-queue.ts` (`NewestJob`): a superseded sweep resolves only once the newest one has applied ([TEST-REACTIVITY]).

### Open question: does this actually close #249 for a default xunit.v3 project? — **NOT CHANGED: conflicts with a frozen test**

> xunit.v3's built-in `--report-xunit-trx` could be a fallback when `--report-trx` is rejected. But `test-explorer-mtp-modules.test.ts`, frozen by the user, asserts that such a module reports `notRun` with the TrxReport message. The fallback would break that test, so this needs the user's decision. The coverage half is fixed: a rejected `--coverage` now names `Microsoft.Testing.Extensions.CodeCoverage` (`test-explorer-mtp-batches.test.ts`).

Every xunit.v3 and NUnit fixture adds `Microsoft.Testing.Extensions.TrxReport`. A default `xunit.v3` 4.0.0 project does not reference that package. So in the reported case, tests are **discovered but cannot be run**: every run ends with the "add the package" message. xunit.v3 ships its own TRX reporter (`--report-xunit-trx`), which may avoid the extra package; this needs checking.

Run with Coverage has the same kind of dependency. It needs `Microsoft.Testing.Extensions.CodeCoverage`. Without it, `--coverage` is rejected with exit code 5 and the run produces **no test results at all**, and the message ("does not support --coverage.") does not name the package the way the TrxReport message does.

---

## E2E coverage

### Well covered

- The tree for all six framework × language fixtures: ids, labels, the Assembly → Namespace → Class → Test levels, and exactly the expected leaves.
- F# backtick ids with spaces, the F# nested-type `+`, MSTest's bare display name never becoming an id, and NUnit decorated uids passed literally.
- Source locations, including NUnit, which reports none.
- Pass, fail and skip attribution using each framework's own assertion text.
- A theory whose rows disagree judged by its worst row, and a class-row run.
- The NUnit F# refusal and its retry, and the C# selection that must not be retried.
- The missing-TrxReport message (single module only).
- The parser suite: `global.json` decoys, a BOM, `schemaVersion`, the uid batcher, and both forms of the pid line.

### Not covered

| # | Behaviour / code | Status | What is missing |
|---|---|---|---|
| 1 | Detection with **no** opt-in through `listTests`: VSTest passes, then the MSBuild probe ([test-discovery.ts:178-190](../../src/editors/vscode/src/test-discovery.ts#L178)). This is how #249 was reported. | **Untested** | The "NO global.json" test ([test-explorer-mtp.test.ts:274](../../src/editors/vscode/src/test/suite/test-explorer-mtp.test.ts#L274)) calls `listMtpTests` directly, and that function never reads `global.json`. Neither the fallback branch nor the merged warnings run. It needs to go through `discoverSolution`. |
| 2 | Debug profile on MTP: `TESTINGPLATFORM_WAIT_ATTACH_DEBUGGER`, attach to the module pid, breakpoint hit, several modules in sequence | **Untested** | Only the pid parser has tests. The `debug-tests` chunk uses VSTest fixtures only. |
| 3 | Run with Coverage on MTP, and the new depth-0 `<guid>.cobertura.xml` read in `findCoberturaFiles` ([test-coverage.ts:64-77](../../src/editors/vscode/src/test-coverage.ts#L64)) | **Untested** | Not even a unit test with a synthetic directory. No fixture references the CodeCoverage extension. |
| 4 | Edit → save → ▶ (B1) | **Untested** | |
| 5 | Multi-targeted MTP project: tree merge, the second `TargetPath` evaluation, and TRX names (B2) | **Untested** | |
| 6 | Mixed VSTest + MTP, in a multi-root workspace or in one solution (R1) | **Untested** | The MTP suites run in their own chunk, so nothing checks the plan resetting between a VSTest and an MTP solution in one extension host. |
| 7 | Several modules where one fails (B3) | **Untested** | |
| 8 | Status CodeLens `runTest(testId)` → `runOne` → `dispatch` on MTP | **Untested** | The lens suites use VSTest fixtures. |
| 9 | Directory and project-file targets (`projectsUnder`, `isSolutionFile`) (B5) | **Untested** | |
| 10 | MTP below 2.3 rejecting `--list-tests json`: the warning in `listModule` ([test-mtp-discovery.ts:58-68](../../src/editors/vscode/src/test-mtp-discovery.ts#L58)) | **Untested** | The plan names this case (MSTest 3.11) but has no fixture for it. |
| 11 | ⏹ on an MTP run | **Weak** | Asserts only that the tree still stands. It does not assert that the cancelled run cached or painted nothing, which is the contract the VSTest suite checks. |
| 12 | Pure helpers: `mergeOutcomes`, `mergeSummaries`, `needsUnfilteredRetry`, `invocationFailure` (non-TRX branches), `mergePlans`, and killed-run handling | **Indirect only** | Each is small and pure. Direct unit tests in the parser suite would pin B3 and B6. |
| 13 | Windows: `dotnet exec` on Windows paths, BOM-prefixed listings, `sln list` backslash paths | **Untested in CI** | CI has never run. The parser test covers the BOM. |

## Suggested additions, in priority order

1. **Edit-then-run** (B1): discover, then flip an assertion and save; ▶ must report the new outcome, and the CodeLens must repaint.
2. **Multi-targeted MTP fixture** (B2, #5): `net8.0;net10.0` with a test behind `#if` that fails on one framework only. Check one tree root, then ▶ on the root reports the failure.
3. **Mixed runners** (R1, #6): a VSTest folder plus an MTP folder in one workspace; ▶ on a test from each and on the root, with every test reporting a result.
4. **No opt-in through the controller** (#1): delete `global.json`, then run `discoverSolution`, then ▶. This is the flow issue #249 describes.
5. **MTP Debug** (#2): one test with a breakpoint hit, plus a selection spanning two modules.
6. **MTP coverage** (#3): a fixture with CodeCoverage, and one without it (the message must name the package).
7. **Two modules, one without TrxReport** (B3, #7): the TrxReport message must reach that module's tests.
8. **Unit tests** for the pure helpers in #12, and for `findCoberturaFiles` at both depths.
9. **Get CI approved and green** on the Windows matrix before merge.
