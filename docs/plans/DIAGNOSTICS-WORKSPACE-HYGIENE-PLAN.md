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

- [x] Failing E2E test: open the repo-shaped fixture with a gitignored nested repo and an `obj/*.AssemblyInfo.fs`; assert workspace pull returns zero reports for both while an opened file there still gets direct-document diagnostics
- [x] Exclude `bin/`/`obj/` generated sources from workspace pulls in both engines via the tier path modules (`paths.rs`, `NativePaths`) — reuse `paths/inputs.rs` obj/bin detection, no new path code
- [x] Exclude gitignored paths from workspace pulls (folder-workspace discovery skips projects under ignored dirs; `real-world-fixtures/` disappears)
- [x] Spec the rule under [DIAG-CONFIG] in `docs/specs/DIAGNOSTICS-SPEC.md` with an ID and cite it in code/tests
- [x] IDE0001/IDE0002 are true positives (Roslyn marks exactly the redundant qualifier or type arguments; the build cannot enforce these two rules): the 37 occurrences are removed at the reported spans. The real bug was that the error came with no quick fix — code actions ran only four style analyzers; they now act on every analyzer diagnostic the report shows (`SimplifyNameFixTests`, [DIAG-CATEGORIES-ANALYZER])

## [DIAG-HYGIENE-CODE] Our code to fix

- [x] FS3886 (173, fixed at the compiler-reported ranges by `tools/debug/fix-diagnostics.mjs --code FS3886`): wrap single-tuple list elements in parentheses (`[ ("Only.fs", src) ]`) across `SharpLsp.Sidecar.FSharp.Tests`
- [x] FL0067/FL0068 (52 identifiers, renamed through SharpLsp's own `textDocument/rename` by `tools/debug/fix-diagnostics.mjs --rename`; the one collision it let through became the F# rename conflict check): rename test/tool identifiers to camelCase (`GuardMethod`, `KIND_SOURCE`, …) via SharpLsp rename, not text edits
- [x] FL0085/FL0083: `[<TailCall>]` on the 14 functions the compiler proves tail-recursive, with FS3569 now enforced in the three F# projects; the bogus `rec` is dropped. Local functions cannot carry the attribute and tree or task recursion is not tail recursion, so the repo `fsharplint.json` (upstream defaults) turns that one rule off. Original item: add `[<TailCall>]` where truly tail-recursive, drop bogus `rec`
- [x] FL0034/FL0035/FL0014/FL0055/FL0072/FL0090 (three synchronous bridges keep `Async.RunSynchronously` with a stated reason): apply the lint fixes (SharpLsp code actions where offered)
- [x] SLSPF0102/0103 in hand-written sources: remove unused opens and redundant qualifiers — applied with SharpLsp's own "Fix all in solution" through `tools/debug/fix-diagnostics.mjs --fix-all` (25 opens, 67 qualifiers; the fixtures that demonstrate them are left as they are)
- [x] SLSPC0101: `WellKnownPackages.All` is deleted (nothing references it); `DiagnosticWorkspacePulls` is referenced and no longer reported; the report on `MsBuildRegistration` was a false positive — a class holding only a `[ModuleInitializer]` — fixed in the analyzer with a failing-first test
- [x] Non-demo fixtures (tests assert names and positions on those six lines, so each finding is suppressed on its own line with `fsharplint:disable-line`, changing no position): fix FL0065/FL0037/FS3886 in `fsharp-profiling` and `workspace/fsharp` unless a test asserts them (grep test suites first)

## [DIAG-HYGIENE-GUARD] Ratchet

- [x] (`make _check-workspace-diagnostics`, run by the existing Tooling job with the prebuilt host and sidecars) Add a CI step that runs the host's workspace diagnostics over the repo and fails on any report outside the allow-listed demo fixtures (`diagnostic-lint`, `diagnostic-tags`, `diagnostic-cancellation`)
- [x] FSharpLint has no severities to promote; the guard fails on a finding of any severity outside the demo fixtures, so a regression of any fixed rule breaks the build. Original item: promote the fixed FSharpLint rules to errors in the repo's lint config so regressions break the build
- [ ] Re-run the Problems-panel count; target: only demo-fixture diagnostics remain. Delete this plan
