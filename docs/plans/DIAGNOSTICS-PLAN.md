# [DIAG-PLAN] Diagnostic Truth and Refresh Plan

Release regression: [#441](https://github.com/Nimblesite/SharpLsp/issues/441). Analyzer false negatives: [#343](https://github.com/Nimblesite/SharpLsp/issues/343).

Behavior is defined by [DIAGNOSTICS-SPEC.md](../specs/DIAGNOSTICS-SPEC.md). The published pull-diagnostics article remains a promise to implement. Compiler build oracles and real editor observations determine success.

## [DIAG-PLAN-PROOF] Regression Evidence

- [x] Real VSIX fixtures independently fail the F# and C# compiler with FS0001 and CS0029 while an unrelated clean file resolves through its real sidecar.
- [x] Confirm 12 genuine VSIX failures for capability negotiation, closed-file workspace reports, automatic Problems publication, disk fix/regression cycles, unsaved dependency edits and live solution scope.
- [x] Confirm three native LSP process failures for modern capability negotiation, closed-file pull reports and missing F# closed-file legacy publications.
- [x] Confirm three real VSIX analyzer failures after a genuine CA1822 compiler build oracle: live fixes, analyzer configuration and suppression changes.
- [x] Run all regression assertions green against final staged binaries: 45 real VSIX cases including Razor, 832 C# and 463 F# engine cases. Existing asynchronous package assertions wait for their intended current Problems state without removing assertions or extending their existing response budgets.
- [x] Preserve the observable legacy restore-pending notice without speculative package errors, then clear it before the first resolved package hover. The unchanged native regression, all 832 C# cases and all 45 diagnostic VSIX cases pass after the reactive IPC fix.
- [ ] Prove solution replacement removes previous workspace errors without a window restart.
- [ ] Prove sidecar failures/restarts cannot memoize an empty false-clean result.
- [ ] Re-run the real FluentValidation and Serilog diagnostic edit/clear cases that failed the full Windows baseline.

## [DIAG-PLAN-PULL] Protocol and Query Ownership

- [x] Prefer textDocument.diagnostic when the client also supports publishDiagnostics; advertise stable sharplsp identifier and inter-file/workspace support.
- [x] Suppress publications to negotiated pull clients, preserving one diagnostic identity and exact counts.
- [x] Enumerate actual Roslyn/FCS source metadata without eager compilation; route every source to its language engine.
- [x] Keep all computed diagnostic memoization in shared lspkit Salsa infrastructure. Extension/sidecar state retains no parallel diagnostic result cache.
- [x] Return full/unchanged reports with opaque snapshot IDs; stable pulls skip IPC and semantic recomputation.
- [x] Stream workspace partial results and explicit empty reports for excluded documents; live solution opt-out proves retirement of closed-file results.
- [x] Keep compiler/IPC failures as retriable request errors and invalidate failed query results for retry, including unavailable language engines.
- [x] Prove cancellation (-32800), supersession (-32802/retrigger), malformed parameters (-32602), foreground hover responsiveness and no post-terminal/stale-version partial reports through a real 128-source mixed solution.
- [ ] Propagate per-request cancellation through IPC into Roslyn/FCS compiler work; current protocol cancellation replies promptly and stops scanning between documents, but cannot abort an in-flight compiler request.
- [ ] Remove the bulk workspace/diagnostics/all RPC and its eager compilation/verification implementation.

## [DIAG-PLAN-INPUTS] Changes and Lifetime

- [x] Invalidate dependent reports before and after source mutations, including unsaved overlays and closed-file disk changes; input revisions cannot block behind compiler queries.
- [x] Follow selected solutions outside editor workspace folders using reactive input watchers, without retaining diagnostic data in the extension.
- [x] Reload changed project/analyzer/editorconfig inputs; real CA1822/NoWarn transitions prove policy changes.
- [ ] Add an explicit integration assertion for unsaved overlay replay during project reload and closed overlay retirement across that reload.
- [x] Deliver typed background compiler notifications while IPC is idle; shared transport belongs to lspkit and refresh is explicitly negotiated for older callers.
- [x] Preserve a visible terminal error for truncated native IPC prefixes/payloads, including after valid responses; zero-byte EOF remains clean (lspkit #21, native RED/GREEN regression).
- [ ] Wire restore completion and owning-project adoption to diagnostic refresh for both language engines.
- [ ] Coalesce refreshes and preserve generation ordering across edits, workspace replacement and process recovery.
- [ ] Invalidate only the required dependency graph when a compiler input changes; verify unrelated result identities remain stable where safe.

## [DIAG-PLAN-ENGINES] Compiler and Analyzer Truth

- [x] F# first: include every loaded project's compiled source and preserve compiler parse/type errors.
- [x] Share the C# analyzer pipeline with the existing resolver; honor the evaluated SDK/NuGet analyzer references and effective editorconfig options without injecting analyzers the project disables.
- [x] Prove unopened default Razor SDK components participate in workspace pulls, map CS0029 to the component source and clear after a compiler-verified disk repair.
- [x] Respect NoWarn, source suppressions, analyzer opt-out and effective severity without suppressing compiler errors.
- [ ] Prove actual generated-source and global/project diagnostic errors remain visible at an appropriate user/project location.
- [ ] Apply the NuGet restore gate before compiler workspace creation; surface restore failures honestly.
- [ ] Preserve F# FSharpLint/FSharp.Analyzers.SDK and SharpLsp static analyzer behavior.
- [ ] Supply codeDescription URLs and unnecessary tags where specified.

## [DIAG-PLAN-CONFIG] Configuration

- [x] Default solution_wide_analysis to true; live opt-out clears closed-file results while preserving open-file errors.
- [ ] Implement project filter globs for workspace pulls without filtering direct document requests.
- [ ] Apply analyzers_enabled before the first analysis and after live configuration changes/restarts.
- [ ] Implement and validate min_severity, max_per_file, refresh_debounce_ms and auto_restore_on_open.

## [DIAG-PLAN-VERIFY] Integration and Delivery

- [ ] Meet source size/function limits; reuse canonical helpers and pass the existing Deslop duplication ratchet.
- [ ] Run strict Rust format/clippy, sidecar checks, VSIX type/lint/format checks and relevant existing suites.
- [ ] Promote only reviewed, proven private changes with coordinated source locks; preserve the separate CI collector's artifacts until it exits naturally.
- [ ] Commit/push shared lspkit changes before the parent feature branch pointer.
- [ ] Run the exact complete CI preparation workflow on the final branch, then coordinate PR/CI/release ownership.
- [x] Make the shared toolkit coverage gate fail closed for missing tools/inputs and invalid thresholds; twelve real CLI regressions pass on Windows and Ubuntu without lowering any coverage floor (lspkit #22).

## [DIAG-PLAN-ADVANCED] Subsequent Analysis

- [ ] Code metrics (cyclomatic complexity).
- [ ] Value tracking/data-flow analysis.
