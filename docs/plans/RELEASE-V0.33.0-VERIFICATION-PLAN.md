# Released v0.33.0 issue verification

## [RELEASE-VERIFICATION-SCOPE]

Verify every open issue that may have been fixed, including fixes predating v0.32.1. Only live behavior from official published v0.33.0 host, bundled engines and editor packages can justify closing a runtime bug. Post passing or failing evidence to each issue. Preserve every confirmed failing scenario as an explicitly skipped regression test. Platform-specific and infrastructure issues require matching evidence before closure.

The user set a hard stop of 03:00 Australia/Melbourne on 2026-11-11, equivalent to 2026-11-10 16:00 UTC. Stop starting new probes before that cutoff and finish cleanup and reporting by then.

## [RELEASE-VERIFICATION-PROVENANCE]

- [x] Download official macOS arm64 archive for v0.33.0.
- [x] Verify SHA-256 against release SHA256SUMS and asset digest.
- [x] Verify extracted host reports `sharplsp 0.33.0`.
- [x] Pin both compiler engines to that same extracted archive.

Archive SHA-256 `4d8e760fb71ccd9bf11e68ea7b0de4d33ba2e2141f223be3681caea0c53729da`. Published 2026-11-10T06:06:01Z. Live probes and raw results are retained under `target/codex1-release-v0330/`. Fixture builds compile only test input projects.

## [RELEASE-VERIFICATION-RESULTS]

The initial snapshot contains 149 open issues. Issue #566 was subsequently added for release-specific reproduction. A checked row means the verification disposition is recorded with live evidence, including a failing disposition. Unchecked rows still require work.

Confirmed failures have enabled regression tests that fail on the official release and default to explicit skips. Tests live in `tools/release/`. Run them with `RUN_RELEASE_REGRESSIONS=1 SHARPLSP_RELEASE_BUNDLE=/absolute/path/to/extracted/bundle SHARPLSP_RELEASE_VSIX=/absolute/path/to/extracted/extension node --test --test-concurrency=1 tools/release/*.test.cjs`.

- [ ] [#566](https://github.com/Nimblesite/SharpLsp/issues/566) F# sidecar high memory during editing — Pending release-specific reproduction. Exact engine identity and retained-growth timeline requested from reporter.

- [ ] [#564](https://github.com/Nimblesite/SharpLsp/issues/564) Logging is far too verbose by default: add config-controlled logging modes (quiet/normal/verbose/trace) with a quieter default — Pending release verification.
- [ ] [#563](https://github.com/Nimblesite/SharpLsp/issues/563) Initial TestFixtures.sln load is 30-110s: F# sidecar restores and loads every .fsproj under the folder (33 projects), re-restoring 'stale' projects on every open — Pending release verification.
- [x] [#562](https://github.com/Nimblesite/SharpLsp/issues/562) F# references, implementations and call hierarchy ignore request cancellation — All three ignore real cancellation until the native FCS source read releases after20s. Three enabled regressions fail the2s cancellation assertion, skipped by default. Evidence posted, issue open.
- [ ] [#561](https://github.com/Nimblesite/SharpLsp/issues/561) Host can deadlock after sharplsp/loadSolution: synchronous Salsa invalidate on a Tokio worker — Pending release verification.
- [x] [#559](https://github.com/Nimblesite/SharpLsp/issues/559) C# rename silently returns null for invalid identifiers instead of an LSP error — Passed live release test, evidence posted, issue closed.
- [x] [#557](https://github.com/Nimblesite/SharpLsp/issues/557) Find references on a C# symbol from F# omits its C# declaration and uses — Failed or partial, evidence posted, skipped regression preserved, issue open.
- [x] [#555](https://github.com/Nimblesite/SharpLsp/issues/555) F# signature help disappears inside multiline calls — Passed live release test, evidence posted, issue closed.
- [x] [#554](https://github.com/Nimblesite/SharpLsp/issues/554) Opening only a C# file starts the F# compiler too — Passed live release test, evidence posted, issue closed.
- [x] [#553](https://github.com/Nimblesite/SharpLsp/issues/553) Rootless F# script: hover and other semantic requests answer null — Passed live release test, evidence posted, issue closed.
- [x] [#552](https://github.com/Nimblesite/SharpLsp/issues/552) F# signature help always highlights the first parameter — Passed live release test, evidence posted, issue closed.
- [ ] [#540](https://github.com/Nimblesite/SharpLsp/issues/540) Scaffolding e2e (Windows): a previous test's new file lands in the comment-trap csproj — Pending release verification.
- [ ] [#536](https://github.com/Nimblesite/SharpLsp/issues/536) Profiler messages misled .NET users: ':0' leak offer, 'press Continue', 'csharp/fsharp' — Pending release verification.
- [ ] [#533](https://github.com/Nimblesite/SharpLsp/issues/533) Running an .fsx: the dotnet fsi task never reports an exit on Windows CI — Pending release verification.
- [ ] [#532](https://github.com/Nimblesite/SharpLsp/issues/532) Test Explorer silently drops a framework from a multi-targeted test project on Windows — Pending release verification.
- [ ] [#530](https://github.com/Nimblesite/SharpLsp/issues/530) Memory autopilot stops capturing after a stop lands while a capture is in flight — Pending release verification.
- [ ] [#521](https://github.com/Nimblesite/SharpLsp/issues/521) Test output (ITestOutputHelper, TestContext, captured console) is never shown in Test Results — Pending release verification.
- [ ] [#519](https://github.com/Nimblesite/SharpLsp/issues/519) F# task {} logical await stack drops to the leaf frame on a slow Linux runner — Pending release verification.
- [ ] [#518](https://github.com/Nimblesite/SharpLsp/issues/518) Diagnostic policy F# workspace assertion counts a C# warning from another suite's open document (Windows) — Pending release verification.
- [ ] [#517](https://github.com/Nimblesite/SharpLsp/issues/517) Owner adoption through a symlinked spelling makes the user's next C# build recompile (Linux) — Inconclusive on official macOS and Linux releases. Owner hover remains null, so incremental adoption cannot be proved. Evidence posted and skipped regression preserved.
- [ ] [#513](https://github.com/Nimblesite/SharpLsp/issues/513) F# solution-wide queries pay a cold full check: warm projects in the background after load — Pending release verification.
- [ ] [#511](https://github.com/Nimblesite/SharpLsp/issues/511) DAP handshake test checks for the disconnect's answer before it can arrive — Pending release verification.
- [ ] [#510](https://github.com/Nimblesite/SharpLsp/issues/510) Problems checks in the diagnostic suites race the editor's own pull — Pending release verification.
- [ ] [#509](https://github.com/Nimblesite/SharpLsp/issues/509) Diagnostic accuracy tests fail when the server asks for a superseded pull to be retriggered — Pending release verification.
- [ ] [#508](https://github.com/Nimblesite/SharpLsp/issues/508) Router's continue past its injected entry stop cancels the client's in-flight threads request — Pending release verification.
- [ ] [#507](https://github.com/Nimblesite/SharpLsp/issues/507) Windows Test Explorer discovery intermittently lists one of two VSTest assemblies, and the timed-out test then unloads the next test's solution — Pending release verification.
- [ ] [#504](https://github.com/Nimblesite/SharpLsp/issues/504) F# code lens on a cold solution blocks every F# request for ~13 s — Pending release verification.
- [ ] [#496](https://github.com/Nimblesite/SharpLsp/issues/496) Windows: exception panel loses the exception message when netcoredbg reports <unknown module> — Pending release verification.
- [ ] [#493](https://github.com/Nimblesite/SharpLsp/issues/493) [Feature]: Add code files automatically linked `.fsproj` — Pending release verification.
- [x] [#491](https://github.com/Nimblesite/SharpLsp/issues/491) Solution replacement can discard current unsaved diagnostic inputs — Linux FCS native-read proof passes workspace/document/lens replacement, unsaved overlays and explicit retirement. C#4 switchbacks and both-language all-owner crash replay pass. Evidence posted, issue closed.
- [ ] [#490](https://github.com/Nimblesite/SharpLsp/issues/490) Native watcher overflow drops rescan signals and leaves closed compiler diagnostics stale — Pending release verification.
- [ ] [#489](https://github.com/Nimblesite/SharpLsp/issues/489) Windows F# diagnostic refresh can collide with project-file edits (EBUSY) — Pending release verification.
- [ ] [#486](https://github.com/Nimblesite/SharpLsp/issues/486) Preserved project timestamps hide changes to the target framework set — Pending release verification.
- [ ] [#485](https://github.com/Nimblesite/SharpLsp/issues/485) Preserved project timestamps hide package changes and compiler errors — Pending release verification.
- [x] [#484](https://github.com/Nimblesite/SharpLsp/issues/484) C# sidecar still exposes the forbidden eager bulk diagnostic route — Both released engines reject valid bulk IPC with Unknown method, retain working metadata/lazy pulls and pass four SDK build controls. Evidence posted, issue closed.
- [x] [#483](https://github.com/Nimblesite/SharpLsp/issues/483) Restore can falsely succeed for invalid imported MSBuild inputs — Both published engines reject missing/malformed imports twice with assets retained, recover in the same process, honor imported constants, preserve project bytes/timestamps and pass six SDK builds. Evidence posted, issue closed.
- [ ] [#482](https://github.com/Nimblesite/SharpLsp/issues/482) Imported MSBuild package changes leave stale F# and C# diagnostics — Pending release verification.
- [x] [#481](https://github.com/Nimblesite/SharpLsp/issues/481) F# diagnostics ignore assemblies in NuGet fallback package folders — Published VSIX passes real SDK fallback-only package, external F# owner adoption, exact closed FS0193, repair/regression/repair, preserved selected error and SDK controls. Evidence posted, issue closed.
- [ ] [#479](https://github.com/Nimblesite/SharpLsp/issues/479) Reference graph type picker closes before a selection in an existing workspace — Pending release verification.
- [ ] [#477](https://github.com/Nimblesite/SharpLsp/issues/477) CPU attribution regression compares different sampling and Stopwatch windows — Pending release verification.
- [ ] [#476](https://github.com/Nimblesite/SharpLsp/issues/476) CPU snapshot can retain only the previous workload after a live phase change — Pending release verification.
- [x] [#475](https://github.com/Nimblesite/SharpLsp/issues/475) Cancelled diagnostic requests leave obsolete compiler work blocking fresh results — Passed official Linux FCS native held-read cancellation and macOS Roslyn analyzer token cancellation, same-process recovery/repair/close, exactly one terminal through EOF and clean shutdown. Evidence posted, issue closed.
- [x] [#474](https://github.com/Nimblesite/SharpLsp/issues/474) Completed SDK restores can leave workspace opening waiting on output pipes — Four released engines pass twelve concurrent forced SDK restores, including Razor, observed four-way restore overlap with disable-build-servers, twelve SDK builds and clean engine exits. Evidence posted, issue closed.
- [x] [#473](https://github.com/Nimblesite/SharpLsp/issues/473) Imported package references can skip workspace restore — F# and C# imported props package additions trigger observed restore, clean closed-source diagnostics, real package hover and no-restore SDK success, preserving project bytes/mtime and opt-out. Evidence posted, issue closed.
- [ ] [#472](https://github.com/Nimblesite/SharpLsp/issues/472) Resolve compiler apphost aliases in recovery fixtures — Pending release verification.
- [ ] [#471](https://github.com/Nimblesite/SharpLsp/issues/471) Use compiler-owned projects in diagnostic protocol smoke tests — Pending release verification.
- [x] [#470](https://github.com/Nimblesite/SharpLsp/issues/470) Cold compiler engines return false-clean document diagnostics before owner adoption — Both cold directions return -32802 with retriggerRequest false, failing required true. SDK/selected controls pass. Evidence posted, two skipped regressions, issue open.
- [x] [#469](https://github.com/Nimblesite/SharpLsp/issues/469) F# lint findings are missing and compiler API failures become false-clean lint results — Published FCS43.12.403/lint0.33 VSIX matches10 upstream oracle inputs,28 Problems observations, FL0065/FL0071 ranges, closed/unsaved/config/suppression transitions, honest failures with compiler preservation, policy and8 fresh cancellations. Evidence posted, issue closed.
- [ ] [#468](https://github.com/Nimblesite/SharpLsp/issues/468) Build the real SDK fixture before verifying native diagnostic repair — Pending release verification.
- [x] [#466](https://github.com/Nimblesite/SharpLsp/issues/466) Native diagnostic watching misses newly created SDK source files — Official macOS/Linux releases pass two native create/delete cycles each, SDK error oracles, standard refresh, explicit changed-ID retirement and current-scope removal, preserving unsaved F# and unrelated closed C# errors. Evidence posted, issue closed.
- [x] [#465](https://github.com/Nimblesite/SharpLsp/issues/465) Automatic workspace restore can leave corrupt SDK assets after reporting success — Both released compilers repair truncated/empty-object assets, preserve opt-out, propagate genuine restore failure, recover in-process and negotiate completion correctly. SDK303/403 host and SDK303 IPC/SDK oracles pass. Evidence posted, issue closed.
- [ ] [#464](https://github.com/Nimblesite/SharpLsp/issues/464) Restore sidecar coverage gates for diagnostic and SDK restore lifecycles — Pending release verification.
- [x] [#463](https://github.com/Nimblesite/SharpLsp/issues/463) Closed diagnostics outside the selected solution directory do not refresh — Official VSIX actual Problems passes C#→F#, F#→F#, F#→C# external owner adoption plus disk-only repair/regression/repair, exact ranges, SDK oracles and workspace exclusion. Evidence posted, issue closed.
- [x] [#462](https://github.com/Nimblesite/SharpLsp/issues/462) External F# projects stay unloaded after selecting a C#-only solution — Official VSIX publishes unopened FS0001 after only clean external Entry opens, retaining selected C# error and disk repair/regression/repair and SDK oracles pass. Evidence posted, issue closed.
- [ ] [#461](https://github.com/Nimblesite/SharpLsp/issues/461) Honor Linux-only chunks in full VS Code test runs — Pending release verification.
- [x] [#459](https://github.com/Nimblesite/SharpLsp/issues/459) Honor auto_restore_on_open before compiler workspace creation — Both languages pass default/opt-out/live opt-in for missing assets and cache files, marker/SDK oracles and package hover. Owner/file-based boundaries retained. Evidence posted, issue closed.
- [x] [#458](https://github.com/Nimblesite/SharpLsp/issues/458) Report missing project-level compiler failures in workspace diagnostics — Official VSIX Problems/workspace and SDK oracles pass8 FS0084/CS5001 project transitions and3 generated CS0029 transitions, exact zero ranges/counts, analyzer opt-out and no extra hidden project hints. Evidence posted, issue closed.
- [x] [#452](https://github.com/Nimblesite/SharpLsp/issues/452) Implement promised diagnostic severity and per-file limits — Official VSIX passes16 policy steps across pulls/Problems. Invalid settings rejected and3 legacy restore-publication arms converge. Evidence posted, issue closed.
- [ ] [#449](https://github.com/Nimblesite/SharpLsp/issues/449) Background diagnostics force-kill a healthy sidecar during shutdown — Pending release verification.
- [ ] [#447](https://github.com/Nimblesite/SharpLsp/issues/447) Restore exact .NET Framework Run exit-code checks — Pending release verification.
- [ ] [#446](https://github.com/Nimblesite/SharpLsp/issues/446) Test Explorer CI shard exceeds its whole-run ceiling after fresh-build coverage — Pending release verification.
- [ ] [#445](https://github.com/Nimblesite/SharpLsp/issues/445) Website F# film intermittently stalls after seeking in Linux Chromium — Pending release verification.
- [ ] [#444](https://github.com/Nimblesite/SharpLsp/issues/444) SDK fixtures preserve installation links instead of copying SDK files — Pending release verification.
- [ ] [#443](https://github.com/Nimblesite/SharpLsp/issues/443) Stopping multi-host test debugging leaves other hosts and the run terminal alive — Pending release verification.
- [ ] [#442](https://github.com/Nimblesite/SharpLsp/issues/442) Test run failures copy compiler output into the persisted extension log — Pending release verification.
- [ ] [#441](https://github.com/Nimblesite/SharpLsp/issues/441) Solution diagnostics are missing or stale despite pull diagnostic truth guarantees — Pending release verification.
- [ ] [#440](https://github.com/Nimblesite/SharpLsp/issues/440) Failed language-server startup leaks build discovery observers — Pending release verification.
- [ ] [#439](https://github.com/Nimblesite/SharpLsp/issues/439) Windows Defender blocks the generated Release test fixture DLL — Pending release verification.
- [ ] [#438](https://github.com/Nimblesite/SharpLsp/issues/438) Windows attach can pause a process but exposes no inspectable managed stack — Pending release verification.
- [ ] [#437](https://github.com/Nimblesite/SharpLsp/issues/437) Shared profiler UI with Osprey: interactive flame graph, palettes, debugger links — Pending release verification.
- [ ] [#435](https://github.com/Nimblesite/SharpLsp/issues/435) Test Explorer hides VSTest compiler diagnostics after build failures — Pending release verification.
- [x] [#434](https://github.com/Nimblesite/SharpLsp/issues/434) C# local hover omits inferred types and nullable flow context — Passed live release test, evidence posted, issue closed.
- [x] [#433](https://github.com/Nimblesite/SharpLsp/issues/433) NuGet restore failures lose MSBuild diagnostics written to stdout — Published host passes6 real props install/uninstall operations, stdout-only MSB1003 and complete mixed-stream failures, ordered targeted progress and responsive subsequent operations. Evidence posted, issue closed.
- [ ] [#431](https://github.com/Nimblesite/SharpLsp/issues/431) Track unpatched Undertow build-tool advisory in Rider dependency graph — Pending release verification.
- [ ] [#430](https://github.com/Nimblesite/SharpLsp/issues/430) Just My Code and exception caller projection misclassify symbol-bearing sibling libraries — Pending release verification.
- [ ] [#429](https://github.com/Nimblesite/SharpLsp/issues/429) Test Explorer must default test builds to Debug with shared configuration — Pending release verification.
- [ ] [#428](https://github.com/Nimblesite/SharpLsp/issues/428) Test Explorer stays stale after extension and external builds — Pending release verification.
- [ ] [#427](https://github.com/Nimblesite/SharpLsp/issues/427) Blazor WebAssembly relaunch races the previous DevServer for its port — Pending release verification.
- [ ] [#426](https://github.com/Nimblesite/SharpLsp/issues/426) Unlisted Razor code-action requests leave stale edits resolvable — Pending release verification.
- [ ] [#425](https://github.com/Nimblesite/SharpLsp/issues/425) Razor code-behind extraction drops generic component type parameters and constraints — Pending release verification.
- [ ] [#424](https://github.com/Nimblesite/SharpLsp/issues/424) Blazor WebAssembly leaves dotnet run alive after the browser debugger stops — Pending release verification.
- [ ] [#394](https://github.com/Nimblesite/SharpLsp/issues/394) Website videos stop after one frame in Windows Chrome and Edge — Pending release verification.
- [x] [#391](https://github.com/Nimblesite/SharpLsp/issues/391) Metadata as source decompiles reference assemblies: every member body is throw null — Failed released-binary navigation. Roslyn AST confirms15 Serialize stubs and zero implementation bodies, with runtime installed. Evidence posted, skipped regression preserved, issue open.
- [x] [#390](https://github.com/Nimblesite/SharpLsp/issues/390) Diagnostics never carry DiagnosticTag.Unnecessary: unused opens and dead code are not greyed out — Passed live release test, evidence posted, issue closed.
- [x] [#389](https://github.com/Nimblesite/SharpLsp/issues/389) F# inlay hints: fully qualified types, parameter names on operators, and hints stacked before the function — Passed live release test, evidence posted, issue closed.
- [x] [#388](https://github.com/Nimblesite/SharpLsp/issues/388) F# hover on a .NET type shows its signature but none of its XML documentation — Failed or partial, evidence posted, skipped regression preserved, issue open.
- [x] [#387](https://github.com/Nimblesite/SharpLsp/issues/387) F#: Go to Definition on Checkout.checkout finds nothing until Checkout.fs has been opened — Passed live release test, evidence posted, issue closed.
- [x] [#386](https://github.com/Nimblesite/SharpLsp/issues/386) Sidecar restart never reopens the workspace: after a crash, the replacement answers every request empty — Passed live release test, evidence posted, issue closed.
- [ ] [#367](https://github.com/Nimblesite/SharpLsp/issues/367) Flaky: Windows realrepo-netfx-fsharp GlobTests hang to the 600 s timeout — Pending release verification.
- [ ] [#363](https://github.com/Nimblesite/SharpLsp/issues/363) Flaky on Windows: CPU snapshot test asserts samples after a fixed 2 s sleep — Pending release verification.
- [ ] [#355](https://github.com/Nimblesite/SharpLsp/issues/355) Profiler: Show Reference Graph started during an auto-capture never returns, and the suspect list resets — Pending release verification.
- [ ] [#354](https://github.com/Nimblesite/SharpLsp/issues/354) Profiler: a memory capture in flight when the target exits never finishes and blocks the next Track Memory — Pending release verification.
- [x] [#343](https://github.com/Nimblesite/SharpLsp/issues/343) [Bug]: C# LSP does not report diagnostics from external analyzers such as StyleCop — Published release reports StyleCop/CA/IDE diagnostics and documentation links, including alongside unsaved compiler errors. Evidence posted, issue closed.
- [ ] [#324](https://github.com/Nimblesite/SharpLsp/issues/324) BUG: website dependency audit blocks release on unpatched braces stack exhaustion — Pending release verification.
- [ ] [#318](https://github.com/Nimblesite/SharpLsp/issues/318) Upstream our netcoredbg patches to Samsung/netcoredbg (hot reload over DAP, symbol-less exception stepping) — Pending release verification.
- [ ] [#314](https://github.com/Nimblesite/SharpLsp/issues/314) F#: a project-wide query right after an unsaved edit re-checks every in-memory reader — Pending release verification.
- [ ] [#310](https://github.com/Nimblesite/SharpLsp/issues/310) CI runs vsce 4 on Node 20 (EOL), below its declared engine node >= 22 — Pending release verification.
- [ ] [#308](https://github.com/Nimblesite/SharpLsp/issues/308) [DIST-CI-ARTIFACT-TESTS] is specified but not implemented: Rust and Zed test jobs still compile — Pending release verification.
- [ ] [#305](https://github.com/Nimblesite/SharpLsp/issues/305) Cross-validate the SDK version predicate against a reference semver implementation — Pending release verification.
- [ ] [#304](https://github.com/Nimblesite/SharpLsp/issues/304) Test-host workspace shapes: the folder editor always starts, and recursive globs skip the multi-root one — Pending release verification.
- [ ] [#303](https://github.com/Nimblesite/SharpLsp/issues/303) A test run can leave the committed workspace fixture's settings.json dirty — Pending release verification.
- [ ] [#293](https://github.com/Nimblesite/SharpLsp/issues/293) NuGetBrowserPanel.waitForInitialLoad() resolves on a load that never ran — Pending release verification.
- [x] [#271](https://github.com/Nimblesite/SharpLsp/issues/271) [SE-ACTIONS-ARGS] Build/Run extra arguments are specified but entirely unimplemented — Published VSIX lacks2 configure commands and3 argument settings. Real command invocation returns not found,5 enabled manifest regressions fail and default to skips. Evidence posted, issue open.
- [ ] [#270](https://github.com/Nimblesite/SharpLsp/issues/270) nuget.update installs whatever version is latest today, and a test drives it into a checked-in fixture — Pending release verification.
- [ ] [#243](https://github.com/Nimblesite/SharpLsp/issues/243) PR #242: nine branch-added assertions that cannot pass against any implementation — Pending release verification.
- [x] [#238](https://github.com/Nimblesite/SharpLsp/issues/238) [Bug]: .editorconfig severity overrides are read once at load and never refreshed — Editorconfig/props/targets/SDK switching pass. New globalconfig remains stale against SDK oracle. Evidence posted, skipped regression preserved, issue open.
- [x] [#237](https://github.com/Nimblesite/SharpLsp/issues/237) LSP host serializes all requests: one slow sidecar call blocks the entire server for up to 2 minutes — Official release FCS held-read blocks warm C# hover and both-language document symbols for19.8s. Three enabled regressions fail the2s independent-response assertion, skipped by default. Evidence posted, issue open.
- [ ] [#235](https://github.com/Nimblesite/SharpLsp/issues/235) Release: publish the two sidecar dotnet tool packages to NuGet — Pending release verification.
- [x] [#221](https://github.com/Nimblesite/SharpLsp/issues/221) F# completion can never offer the auto-open hint C# offers — Hint works, but101 fresh-edit samples after SDK entity update miss budget at154ms p50/242ms p95. Isolated editing control passes84/173ms. Evidence posted, skipped benchmark preserved, issue open.
- [ ] [#210](https://github.com/Nimblesite/SharpLsp/issues/210) Editor integrations: Rider is at 4.09% line coverage, Zed capped at 85% by its WASM-host shell — Pending release verification.
- [ ] [#207](https://github.com/Nimblesite/SharpLsp/issues/207) FluentValidation real-repo diagnostics test: timeout budget is 5 minutes short, and the 18-error baseline is a brittle pin — Pending release verification.
- [ ] [#205](https://github.com/Nimblesite/SharpLsp/issues/205) F# sidecar coverage gate has zero headroom and under-reports inlined functions — Pending release verification.
- [ ] [#203](https://github.com/Nimblesite/SharpLsp/issues/203) Restore C# and F# sidecar coverage to the 95% stored threshold — Pending release verification.
- [ ] [#202](https://github.com/Nimblesite/SharpLsp/issues/202) Flaky: profiler heap-dump test races the target's first allocations — Pending release verification.
- [ ] [#198](https://github.com/Nimblesite/SharpLsp/issues/198) [Feature]: DataProvider Migrations UI — Pending release verification.
- [ ] [#196](https://github.com/Nimblesite/SharpLsp/issues/196) Flaky e2e: profiler object-graph test fails when the baseline heap dump has no StringBuilder instances — Pending release verification.
- [ ] [#176](https://github.com/Nimblesite/SharpLsp/issues/176) [Feature]: MacOS support — Pending release verification.
- [ ] [#170](https://github.com/Nimblesite/SharpLsp/issues/170) NuGet: packages-root prefix strip lacks a separator boundary; parse.rs scrapes MSBuild XML line-wise — Pending release verification.
- [ ] [#168](https://github.com/Nimblesite/SharpLsp/issues/168) Profiler: default output paths are CWD-relative and ProfilerConfig.output_directory is dead — Pending release verification.
- [ ] [#166](https://github.com/Nimblesite/SharpLsp/issues/166) MSBuildInstanceSelector: exact Roslyn version equality — SDK servicing skew falls back to a known-broken registration — Pending release verification.
- [ ] [#164](https://github.com/Nimblesite/SharpLsp/issues/164) Sidecar protocol hardening: response-id correlation + health-check lock race — Pending release verification.
- [ ] [#162](https://github.com/Nimblesite/SharpLsp/issues/162) make _test-vsix cannot go green on Windows — Linux-shaped staging assertions + temp-dir EPERM cleanup flakes — Pending release verification.
- [x] [#154](https://github.com/Nimblesite/SharpLsp/issues/154) READY echoes the requested endpoint even when the listener bound a relocated path — Both official engines on macOS/Linux announce reachable shortened paths for222-byte requests, pass real ping/shutdown and remove their sockets. Evidence posted, issue closed.
- [ ] [#153](https://github.com/Nimblesite/SharpLsp/issues/153) SidecarHost.MessageLoopAsync hot-loops on persistent transport exceptions — Sixteen official macOS/Linux broken-peer controls terminate in8–14ms with socket cleanup. Original persistent exception/Windows pipe branch remains unverified. Partial evidence posted, issue open.
- [x] [#152](https://github.com/Nimblesite/SharpLsp/issues/152) Sidecar spawn-time failures bypass crash backoff — unthrottled respawn storm — Published host allows only3 genuine pre-READY failures during243/291 requests, with1s/2s backoff, then both languages recover on fourth launch. Test launcher execs real published engines. Evidence posted, issue closed.
- [ ] [#151](https://github.com/Nimblesite/SharpLsp/issues/151) Deterministic sidecar IPC endpoint collides across hosts on the same workspace — Published macOS/Linux concurrent hosts pass4 unique endpoints, independent unsaved semantics, peer-shutdown cleanup and fresh surviving edits. Windows named-pipe case remains unverified. Partial evidence posted, issue open.
- [x] [#150](https://github.com/Nimblesite/SharpLsp/issues/150) Sidecar listener failure is invisible: exit 0, no stderr, error only in temp log — Real EADDRINUSE failures in both released engines on macOS/Linux exit1 with one typed fatal/log hint and written logs. Released host reports reaped status/log path and recovers. Evidence posted, issue closed.
- [ ] [#123](https://github.com/Nimblesite/SharpLsp/issues/123) NuGet browser: finish post-install sidecar workspace reload + prerelease/restore polish — Pending release verification.
- [x] [#122](https://github.com/Nimblesite/SharpLsp/issues/122) F#: completion auto-`open` insertion (FSAC parity) needs an unopened-symbol entity index — Published F# alone offers framework/project-local hints, resolves exact opens, compiles accepted protocol edits and handles in-scope/invalid/stale controls. Evidence posted, issue closed. Performance remains on #221.
- [ ] [#48](https://github.com/Nimblesite/SharpLsp/issues/48) Windows code signing — current position — Pending release verification.
- [ ] [#47](https://github.com/Nimblesite/SharpLsp/issues/47) Sign + notarize the macOS binaries — Pending release verification.
- [ ] [#46](https://github.com/Nimblesite/SharpLsp/issues/46) Add Zed LSP-initialize version enforcement — Pending release verification.
- [ ] [#45](https://github.com/Nimblesite/SharpLsp/issues/45) Enforce the expected version during resolution — Pending release verification.
- [ ] [#43](https://github.com/Nimblesite/SharpLsp/issues/43) Shipwright deployment-contract hardening checklist — Pending release verification.
- [ ] [#33](https://github.com/Nimblesite/SharpLsp/issues/33) feat: update Shipwright repo fixtures for Forge after all deployment issues are resolved — Pending release verification.
- [x] [#23](https://github.com/Nimblesite/SharpLsp/issues/23) Rename: F# active patterns — Failed or partial, evidence posted, skipped regression preserved, issue open.
- [x] [#22](https://github.com/Nimblesite/SharpLsp/issues/22) Rename: F# discriminated union cases — Failed or partial, evidence posted, skipped regression preserved, issue open.
- [x] [#21](https://github.com/Nimblesite/SharpLsp/issues/21) Rename: F# record fields — Failed or partial, evidence posted, skipped regression preserved, issue open.
- [x] [#20](https://github.com/Nimblesite/SharpLsp/issues/20) Rename: aliases and type abbreviations — Valid preparation/edits pass for enumerated cases. F# bad! rejection fails and generated edits fail compilation. Evidence posted, skipped regression preserved, issue open.
- [x] [#19](https://github.com/Nimblesite/SharpLsp/issues/19) Rename: generic type parameters — F# and C# generic-parameter live tests passed, including semantic negative control. Evidence posted, issue closed.
- [x] [#18](https://github.com/Nimblesite/SharpLsp/issues/18) Rename: namespaces and modules — Valid preparation/edits pass for enumerated cases. F# bad! rejection fails and generated edits fail compilation. Evidence posted, skipped regression preserved, issue open.
- [x] [#17](https://github.com/Nimblesite/SharpLsp/issues/17) Rename: parameters and lambda parameters — Valid preparation/edits pass for enumerated cases. F# bad! rejection fails and generated edits fail compilation. Evidence posted, skipped regression preserved, issue open.
- [x] [#16](https://github.com/Nimblesite/SharpLsp/issues/16) Rename: local variables and pattern/deconstruction bindings — Valid preparation/edits pass for enumerated cases. F# bad! rejection fails and generated edits fail compilation. Evidence posted, skipped regression preserved, issue open.
- [x] [#15](https://github.com/Nimblesite/SharpLsp/issues/15) Rename: fields and events — Valid preparation/edits pass for enumerated cases. F# bad! rejection fails and generated edits fail compilation. Evidence posted, skipped regression preserved, issue open.
- [x] [#14](https://github.com/Nimblesite/SharpLsp/issues/14) Rename: properties and indexers — Valid preparation/edits pass for enumerated cases. F# bad! rejection fails and generated edits fail compilation. Evidence posted, skipped regression preserved, issue open.
- [x] [#13](https://github.com/Nimblesite/SharpLsp/issues/13) Rename: constructors through containing type rename — Valid preparation/edits pass for enumerated cases. F# bad! rejection fails and generated edits fail compilation. Evidence posted, skipped regression preserved, issue open.
- [x] [#12](https://github.com/Nimblesite/SharpLsp/issues/12) Rename: methods, functions, local functions, and operators — Valid preparation/edits pass for enumerated cases. F# bad! rejection fails and generated edits fail compilation. Evidence posted, skipped regression preserved, issue open.
- [x] [#11](https://github.com/Nimblesite/SharpLsp/issues/11) Rename: enum members — Valid preparation/edits pass for enumerated cases. F# bad! rejection fails and generated edits fail compilation. Evidence posted, skipped regression preserved, issue open.
- [x] [#10](https://github.com/Nimblesite/SharpLsp/issues/10) Rename: enums — Valid preparation/edits pass for enumerated cases. F# bad! rejection fails and generated edits fail compilation. Evidence posted, skipped regression preserved, issue open.
- [x] [#9](https://github.com/Nimblesite/SharpLsp/issues/9) Rename: classes, structs, interfaces, records, and delegates — Valid preparation/edits pass for enumerated cases. F# bad! rejection fails and generated edits fail compilation. Evidence posted, skipped regression preserved, issue open.

## [RELEASE-VERIFICATION-REMAINING]

- [ ] Finish all unchecked runtime candidates and post evidence.
- [ ] Exercise released VSIX for editor-only bugs.
- [ ] Verify Windows and Linux reports on matching released binaries and platforms.
- [ ] Verify CI/tooling issues against the published release run where runtime testing is inapplicable.
- [ ] Confirm every failed runtime scenario has a skipped regression, and every closure has complete acceptance evidence.
- [ ] Remove this plan when the exhaustive audit is complete.
