# Release regression and MTP review

Review date: 2026-09-23. Reviewer: SharpLspAstra1.

Baseline: `7c3b1ce68cd7a4df8b95973b828c80c4335daa2c`.
Current verification: `39a1bd3ce17a619bbccca10023ad191428e8381b` plus the working-tree changes described below. Other contributors are actively changing this shared checkout; these results do not certify their later edits or a future release tag.

## Release position

**Prioritize actual editor/LSP defects.** The C#/F# MTP reporter defect and Roslyn/SDK dependency mismatch are fixed and locally verified. Both default and strict-low dependency audits report zero known vulnerabilities. The missing audit dependency in the terminal CI gate is fixed, with a red-to-green regression test.

This is **not blanket production certification**: the final combined revision still needs its supported-platform CI and release checks. Issue [#270](https://github.com/Nimblesite/SharpLsp/issues/270) has a product decision and explicit spec, but its unbounded update command and fixture-mutation regression remain implementation work. Separate contributors own the remaining release validation and editor bug fixes.

## Product findings and fixes

### [P1] Dependency update breaks the required Roslyn/SDK version alignment — fixed

Files: `.config/dotnet/common.props` and `src/sidecars/SharpLsp.Sidecar.CSharp/SharpLsp.Sidecar.CSharp.csproj`.

The merged dependency update moved runtime Roslyn packages to 5.9 while the pinned SDK 10.0.303 ships Roslyn 5.6. The existing regression `Repo_pinned_sdk_ships_exactly_the_bundled_roslyn` failed unchanged with expected 5.6.0.0, actual 5.9.0.0. This violates the repository's SDK/MSBuild loading contract and risks C# project-load/semantic failures.

Restored only the four runtime Roslyn package pins to 5.6.0. Kept Microsoft.CodeAnalysis.Analyzers 5.9 and MessagePack 3.1.9, including the security/dependency consistency fixes.

Verification: the version-alignment regression passed unchanged, then the complete sidecar run passed **533 C#, 409 F#, 92 Common tests**, with all three coverage gates passing.

An incremental rebuild initially left a 5.9 BuildHost beside 5.6 Roslyn and caused widespread failures. The generated `BuildHost-netcore/*.deps.json` proved the mismatch. After a clean .NET rebuild and fresh publish directory, BuildHost was 5.6 and all tests passed. No assertions were removed or weakened. Release builders must use fresh artifacts, not mixed output from an earlier dependency version.

### [P1] Bare xUnit v3 MTP projects discover but cannot run — fixed for C# and F#

Files: `src/editors/vscode/src/test-mtp-report.ts`, `test-mtp-run.ts`, and the MTP outcome/module suites.

Previously every non-debug MTP invocation passed `--report-trx`, supplied by the optional Microsoft.Testing.Extensions.TrxReport package. Normal xUnit v3 4.0 MTP projects without it discovered tests but failed with exit code 5 and zero results. xUnit provides its own built-in `--report-xunit-trx` reporter; see [the official MTP documentation](https://xunit.net/docs/getting-started/v3/microsoft-testing-platform).

Added real F# and C# fixtures without the optional reporter, confirmed both failed for that exact reason, then implemented a bounded fallback:

- First use the standard reporter.
- Retry with xUnit's built-in reporter only when MTP explicitly rejects `--report-trx`.
- Preserve the selected module, UIDs, unique report filename and results directory.
- Never use this retry for debugging, cancellation/killed runs or ordinary test failures.
- If the fallback reporter is also unsupported, retain the original actionable reporter diagnosis.

The new tests exercise direct runs, Test Explorer profiles and CodeLens, including selected tests, data rows, pass/fail/skip and assertion details. Unsupported-reporter coverage was preserved and expanded using real **F# and C# NUnit** projects without a reporter; it still asserts zero results, an actionable error and no unfiltered retry.

Local real-VS-Code verification: all three MTP chunks completed successfully, including F# debugging, theory breakpoints, multi-target/multi-root, mixed runners, edits/rebuilds and VSTest-to-MTP migration. Details below.

### [P1] NuGet Update can cross versions silently and mutate a checked-in fixture — open #270

The palette command directly invokes unversioned `dotnet add package`. Its test can select the first real workspace project when the intended disposable project is absent. That can modify a committed fixture instead of failing the test setup.

Product decision is posted on [#270](https://github.com/Nimblesite/SharpLsp/issues/270#issuecomment-5784376499) and specified in [NUGET-BROWSER-SPEC.md](../specs/NUGET-BROWSER-SPEC.md), section `[NUGET-REQUESTS-UPDATE]`:

- Latest stable is a proposal within the installed major; for `0.x`, stay within the installed minor.
- Preview and confirm the exact version and target before applying it.
- Major jumps and prereleases require explicit selection.
- No automatic target substitution, versionless mutation, broadened retry, or silent rewriting of ambiguous declarations.
- Reuse the host/MSBuild-DOM package workflow; preserve CPM/shared-props scope.
- Tests use disposable real F#/C# projects, controlled versions and unchanged-fixture assertions.

Implementation remains unchecked in [NUGET-UPDATE-PLAN.md](../plans/NUGET-UPDATE-PLAN.md). The issue is deliberately still open.

## Vulnerability audit and release enforcement

Fresh local commands, both successful:

- `make audit`
- `make audit AUDIT_LEVEL=low`

| Inventory | Result |
| --- | --- |
| Host `Cargo.lock` — 243 dependencies | No vulnerability findings |
| Zed `Cargo.lock` — 93 dependencies | No vulnerability findings |
| Sidecar NuGet solution, direct and transitive | 0 vulnerable packages |
| VS Code npm lockfile, production and development | 0 vulnerabilities |
| Website npm lockfile | 0 vulnerabilities |

The checkout already contains the earlier dependency security fixes, including `f36ae400`; these fresh scans did not identify another vulnerable package requiring an upgrade. No audit threshold was raised and no advisory was suppressed to obtain a pass.

The release workflow already requires a successful reusable audit before GitHub Release creation, and both VSIX marketplaces depend on that release. However, the final PR `CI` job omitted `audit` from its dependencies. Added it. A new YAML-parsing regression failed on the omission before the fix, then passed unchanged.

`tools/ci/security-gates.test.mjs` runs in `make _lint-vsix`, alongside the existing NuGet audit-report tests in tooling. Together **9 security tests pass**, covering vulnerable direct/transitive reports, unusable reports, the final CI dependency, the shared scanner, and both marketplace release dependencies. The contract is explicit in `[DIST-CI-AUDIT]` in [DISTRIBUTION-SPEC.md](../specs/DISTRIBUTION-SPEC.md).

Additional packaged-debugger check: all seven debugger payload files in the freshly built local darwin-arm64 VSIX matched the build-cache bytes by SHA-256. Its managed build manifest identifies the four Roslyn packages at 2.3.0 and Microsoft.Diagnostics.DbgShim at 10.0.745401; neither the current base nor update page of [NuGet's vulnerability feed](https://api.nuget.org/v3/vulnerabilities/index.json) contained advisories for those five package IDs. This was a supplementary read-only check, not a new automated gate.

Scope: these ecosystem scans assess the listed dependency graphs against current advisory databases. They are not a complete native-binary/SBOM scan or an audit of the user's installed .NET runtime. A tagged release must rerun the audit; do not treat this snapshot as a perpetual security certificate.

## C# and F# MTP verification

All runs below completed locally on macOS arm64 with actual VS Code and real .NET test projects, not simulated runner output.

| Run | Result |
| --- | --- |
| `testexplorer-mtp` | 22 passing |
| `testexplorer-mtp-runners` folder workspace | 12 passing |
| `testexplorer-mtp-runners` multi-root workspace | 4 passing |
| `testexplorer-mtp-parity` | 11 passing |
| MTP parser suite | 12 passing |
| Complete .NET sidecar solution | 1,034 passing, 0 skipped |
| Complete Rust host suite | 680 passing, 0 skipped |
| VS Code lint/type checking and security workflow guards | Passed |
| Tooling suite before the new workflow guards | 22/22 passed |

MTP counts include shared staging checks repeated across chunks; they are not a count of unique product scenarios. The parity run includes F# debugger attach/backtick identifiers, per-row theory breakpoints, debug-at-cursor, multi-target projects and changed C#/F# test data.

Coverage gates passed: C# 95.4272%, F# 95.5313%, Common 95.7895%; Rust 94.6505% against its existing 95% threshold with the existing 1-point tolerance. Thresholds were not weakened.

Artifact qualification: the Rust run overlapped the clean sidecar republish and is not an immutable final-binary certification. Its initial staged directory retained the stale BuildHost; the clean .NET run and freshly packaged VSIX used the corrected 5.6 publish. Final CI must rebuild/stage consistently and rerun against that fixed artifact set.

Logs are under `/tmp/sharplsp-mtp-release.jpxAsl/`: `testexplorer-mtp.log`, `testexplorer-mtp-runners.log`, `testexplorer-mtp-parity.log`, `mtp-parsers.log`, `dotnet-sidecars-clean.log`, `rust-host.log`, `release-audit.log`, `release-audit-low.log`, and `security-lint.log`.

The earlier review attempt against `542531e3` was interrupted by an external SIGKILL and missing concurrent build output. It is superseded by these completed MTP runs. Linux/Windows feature checks were green on [PR #262](https://github.com/Nimblesite/SharpLsp/pull/262) and [PR #268](https://github.com/Nimblesite/SharpLsp/pull/268), but those older results do not certify this final combined working tree.

## Test weakening review

In the original reviewed implementation range, no deleted test files or new skip/only markers were found. Approximate test declarations rose from 1,666 to 1,828; skip/only occurrences stayed at five. Inventory counts are not a substitute for behavioral coverage.

The F# rename assertion changed from four symbol uses to three because FSharp.Compiler.Service 43.12.400 no longer returns the zero-width record-copy-update use. The skip-rather-than-abort path remains covered by indexer tests. This reduced assertion has an explained dependency basis; it is not established as unjustified weakening.

Source-location assertions now require Go to Test to land inside the declaration, consistent with the intended behavior. The MTP fix adds successful bare-xUnit coverage without removing the unsupported-runner assertions. No failing assertion was relaxed in the Roslyn alignment fix.

## Deferred process/documentation observations

These are not substitutes for fixing user-visible bugs and are not the current product priorities.

- The main-branch protection inspected during the original review did not require the terminal `CI` status. This observation is time-sensitive; no repository protection setting was changed in this work.
- Distribution-spec reduction in `542531e3` left numerous existing `[DIST-*]` references undefined. The vulnerability contract has now been restored; unrelated specification cleanup remains deferred.
- `CLAUDE.md` includes `@Agents.md` rather than the tracked `AGENTS.md`, which fails on case-sensitive filesystems.

## Remaining release work

1. Implement and verify #270 without modifying checked-in test fixtures.
2. Finish the other contributors' actual editor bug fixes, then validate the combined revision and packaged VSIX on supported CI platforms.
3. Rerun the vulnerability gate against the release tag before either marketplace publishes.
4. Record that final revision and its complete results before declaring production readiness.
