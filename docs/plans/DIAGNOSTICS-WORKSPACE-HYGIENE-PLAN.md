# Diagnostics Workspace Hygiene Plan

Drive the SharpLsp repo's own Problems panel to zero, apart from fixtures that exist to demonstrate or
test diagnostics. Specs: [DIAG-CONFIG], [DIAG-TRUTH-RECOVERY], [SHARPLSP-ARCHITECTURE-PATHS].

## [DIAG-HYGIENE-BASELINE] Baseline (2026-11-14, VS Code Problems panel)

4,460 diagnostics: 36 errors, 3,066 warnings, 181 info, 1,177 hints.

| Bucket | Count | Owner | Action |
|---|---|---|---|
| `real-world-fixtures/fstoolkit` (gitignored clone, mostly FL0069 on camelCase generic params) | 3,400 | Third party | **Not ours to edit.** Stop surfacing it |
| `third_party/**/obj/pinned-source` + every `obj/` `AssemblyInfo.fs` (SLSPF0103/0102) | ~575 | Generated | Never analyse generated output |
| `src/sidecars` F# tests (FS3886 single-tuple lists, FL0067, FL0072, FL0014, FL0055) | ~330 | Us | Fix |
| `src/sidecars` C# IDE0001/IDE0002 (reported as **Error**) | 35 | Us | Verify, then fix or file LSP bug |
| `src/sidecars` F# product code (FL0085, FL0034, FL0083, FL0035, SLSPF0103) | ~40 | Us | Fix |
| `tools/fsharp-lint-source` | ~20 | Us | Fix |
| SLSPC0101 dead code (`WellKnownPackages.All`, `DiagnosticWorkspacePulls`) | 3 | Us | Delete or prove used |
| `src/editors/vscode/test-fixtures/diagnostic-lint`, `src/sharplsp/tests/fixtures/diagnostic-tags` | ~15 | Diagnostic demos | **Keep** |
| Other fixtures (`fsharp-profiling`, `workspace/fsharp`) | ~10 | Us | Fix unless a test asserts the diagnostic |

## [DIAG-HYGIENE-SCOPE] Product fixes (SharpLsp behaviour)

Workspace-wide diagnostics must not report files no developer owns. Rider/VS never lint `obj/`.

- [ ] Failing E2E test: open the repo-shaped fixture with a gitignored nested repo and an `obj/*.AssemblyInfo.fs`; assert workspace pull returns zero reports for both while an opened file there still gets direct-document diagnostics
- [ ] Exclude `bin/`/`obj/` generated sources from workspace pulls in both engines via the tier path modules (`paths.rs`, `NativePaths`) — reuse `paths/inputs.rs` obj/bin detection, no new path code
- [ ] Exclude gitignored paths from workspace pulls (folder-workspace discovery skips projects under ignored dirs; `real-world-fixtures/` disappears)
- [ ] Spec the rule under [DIAG-CONFIG] in `docs/specs/DIAGNOSTICS-SPEC.md` with an ID and cite it in code/tests
- [ ] If IDE0001/IDE0002 are false positives (`dotnet build` with `EnforceCodeStyleInBuild` is clean on the same lines, e.g. `CSharpSidecar.cs:172` `Outcome.Result` qualification), file a GitHub bug and fix via the bug-fix process; otherwise fix the code

## [DIAG-HYGIENE-CODE] Our code to fix

- [ ] FS3886 (~171): wrap single-tuple list elements in parentheses (`[ ("Only.fs", src) ]`) across `SharpLsp.Sidecar.FSharp.Tests`
- [ ] FL0067/FL0068: rename test/tool identifiers to camelCase (`GuardMethod`, `KIND_SOURCE`, …) via SharpLsp rename, not text edits
- [ ] FL0085/FL0083: add `[<TailCall>]` where truly tail-recursive, drop bogus `rec`
- [ ] FL0034/FL0035/FL0014/FL0055/FL0072/FL0090: apply the lint fixes (SharpLsp code actions where offered)
- [ ] SLSPF0102/0103 in hand-written sources: remove unused opens and redundant qualifiers
- [ ] SLSPC0101: delete `WellKnownPackages.All` and `DiagnosticWorkspacePulls` if truly unreferenced
- [ ] Non-demo fixtures: fix FL0065/FL0037/FS3886 in `fsharp-profiling` and `workspace/fsharp` unless a test asserts them (grep test suites first)

## [DIAG-HYGIENE-GUARD] Ratchet

- [ ] Add a CI step that runs the host's workspace diagnostics over the repo and fails on any report outside the allow-listed demo fixtures (`diagnostic-lint`, `diagnostic-tags`, `diagnostic-cancellation`)
- [ ] Promote the fixed FSharpLint rules to errors in the repo's lint config so regressions break the build
- [ ] Re-run the Problems-panel count; target: only demo-fixture diagnostics remain. Delete this plan
