# [DIAG-PLAN] Diagnostic Truth and Refresh Plan

Release regression: [#441](https://github.com/Nimblesite/SharpLsp/issues/441). Analyzer false negatives: [#343](https://github.com/Nimblesite/SharpLsp/issues/343).

Behavior is defined by [DIAGNOSTICS-SPEC.md](../specs/DIAGNOSTICS-SPEC.md). The published pull-diagnostics article remains a promise to implement. Compiler build oracles and real editor observations determine success.

## [DIAG-PLAN-PROOF] Regression Evidence

- [x] Real VSIX fixtures independently fail the F# and C# compiler with FS0001 and CS0029 while an unrelated clean file resolves through its real sidecar.
- [x] Confirm 12 genuine VSIX failures for capability negotiation, closed-file workspace reports, automatic Problems publication, disk fix/regression cycles, unsaved dependency edits and live solution scope.
- [x] Confirm three native LSP process failures for modern capability negotiation, closed-file pull reports and missing F# closed-file legacy publications.
- [x] Prove F# script reference failures appear exactly once at the source, clear after repair and return on regression, with and without explicit workspace reload. Three real VSIX cases pass after genuine missing-error, cascading-error and stale-reference failures (#454); the published interactive settings asset, valid `fsi` binding and real SDK-built relative DLL are verified, with hover before the first diagnostic pull. All 463 existing F# engine cases pass against the integrated script and restore-policy source; the combined editor suite remains required.
- [x] Confirm three real VSIX analyzer failures after a genuine CA1822 compiler build oracle: live fixes, analyzer configuration and suppression changes.
- [x] Run all regression assertions green against final staged binaries: 45 real VSIX cases including Razor, 832 C# and 463 F# engine cases. Existing asynchronous package assertions wait for their intended current Problems state without removing assertions or extending their existing response budgets.
- [x] Preserve the observable legacy restore-pending notice without speculative package errors, then clear it before the first resolved package hover. The unchanged native regression, all 832 C# cases and all 45 diagnostic VSIX cases pass after the reactive IPC fix.
- [x] Prove solution replacement removes previous workspace errors without a window restart; two real solutions switch and switch back in one native session, retiring old reports explicitly.
- [x] Prove sidecar failures/restarts cannot memoize an empty false-clean result. The unchanged native #453 regression fails against the prior compiler session and passes after input restoration: the first successful post-crash pull retains an unsaved FS0039 and closed-file CS0029, the real compiler PID changes, and the host survives. All 36 existing manager regressions pass.
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
- [x] Follow compiler-owned source and project directories outside the selected solution root. Three unchanged real VSIX regressions fail before the fix and pass after it: an external F# owner activates an empty F# slice beside a C# solution, and both languages clear and restore unopened external errors after SDK-verified disk edits. Two unchanged native protocol/SDK cases also pass after genuine failures, with standard refreshes, changed Salsa result identities, no editor file-change notifications and no semantic rescue after edits (#462, #463). Existing selected-project errors remain visible.
- [x] Reload changed project/analyzer/editorconfig inputs; real CA1822/NoWarn transitions prove policy changes.
- [x] Preserve generated compiler errors through analyzer opt-out and reference changes: a real SDK-built IIncrementalGenerator emits CS0029, reported once at the owning project URI with a zero-length 0:0 range. Adding, removing and restoring its Analyzer ProjectReference produces error/clean/error in Problems and workspace pulls while ordinary sources stay clean; all three F#/C#/generated project editor cases pass together.
- [x] Prove unsaved F# overlay replay through actual SDK source creation and metadata reload, retire a deleted C# source explicitly, and restore saved F# errors when its overlay closes. Real SDK build oracles and native reports pass (9321d87d).
- [x] Deliver typed background compiler notifications while IPC is idle; shared transport belongs to lspkit and refresh is explicitly negotiated for older callers.
- [x] Emit actual compiler workspace completion after successful loading in both engines, gated by negotiated IPC notifications. The unchanged native mixed-solution regression fails with zero notifications before the fix and passes through initial load, another solution and switching back with two completion notifications per selection. All 832 C#, 463 F# and 130 Common engine tests pass without skips (#460).
- [x] Preserve a visible terminal error for truncated native IPC prefixes/payloads, including after valid responses; zero-byte EOF remains clean (lspkit #21, native RED/GREEN regression).
- [x] Prove C# background SDK restore completion emits a standard refresh through idle typed IPC, independently of filesystem or semantic-request rescue (81da7b24).
- [x] Prove completed owning-project adoption refreshes closed-file diagnostics, including the first F# owner of a C#-only solution (#462, #463).
- [x] Verify the F# owning-file restore path recreates a fixture-owned missing package cache and updates closed-file Problems automatically. A real Newtonsoft API builds successfully before cache removal; an SDK build without restore then fails for that package. Opening the unselected external F# owner restores its cache and reveals the real closed FS0001, followed by SDK-verified repair and regression. All four ownership VSIX cases pass together without a manual pull or hover; direct idle-IPC notification proof remains separate.
- [x] Prove F# restore completion refreshes diagnostics independently of filesystem or semantic-request rescue (e40d30a6): the actual compiler IPC has no queued notification at the didChange acknowledgment, then emits a typed diagnostics refresh while idle before any further request. The real package cache is restored and the closed FS0001 retains its exact source and range; all 470 F# tests pass with the CI runsettings.
- [ ] Coalesce refreshes and preserve generation ordering across edits, workspace replacement and process recovery.
- [ ] Invalidate only the required dependency graph when a compiler input changes; verify unrelated result identities remain stable where safe.

## [DIAG-PLAN-ENGINES] Compiler and Analyzer Truth

- [x] F# first: include every loaded project's compiled source and preserve compiler parse/type errors.
- [x] Share the C# analyzer pipeline with the existing resolver; honor the evaluated SDK/NuGet analyzer references and effective editorconfig options without injecting analyzers the project disables.
- [x] Prove unopened default Razor SDK components participate in workspace pulls, map CS0029 to the component source and clear after a compiler-verified disk repair.
- [x] Respect NoWarn, source suppressions, analyzer opt-out and effective severity without suppressing compiler errors.
- [x] Prove actual generated-source and global/project diagnostic errors remain visible at their owning project with a zero-length 0:0 range: real FS0084, CS5001 and generated CS0029 editor cases pass in the verified 61-case combined suite, with exact counts and SDK build oracles (8b325497, 57e4a445).
- [ ] Apply the NuGet restore gate before compiler workspace creation; surface restore failures honestly.
- [ ] Preserve F# FSharpLint/FSharp.Analyzers.SDK and SharpLsp static analyzer behavior.
- [ ] Supply codeDescription URLs and unnecessary tags where specified.

## [DIAG-PLAN-CONFIG] Configuration

- [x] Default solution_wide_analysis to true; live opt-out clears closed-file results while preserving open-file errors.
- [x] Match project names, native paths and selected-solution-relative globs for F# and C# workspace pulls; exclusions retire prior reports and direct document requests remain unfiltered. Four live filter transitions per engine and all 14 accuracy cases pass (21253bc3, #451).
- [x] Prove initial analyzer opt-out and live false/true/false transitions through real compiler sessions, preserving compiler errors (83836651).
- [x] Replay analyzer configuration after process recovery (#453): real F# crash restores unsaved FS0039 and closed C# CS0029; real Roslyn crash preserves SDK-confirmed CA1822 opt-out before the first successful pull, then live opt-in restores the analyzer error and opt-out clears it. Both native sessions pass with the same host and new owned compiler PIDs (0c8953e1).
- [x] Validate all four min_severity values and apply max_per_file after filtering, with zero unlimited. Four real F#/C# editor cases fail before the fix and pass afterward; all 21 accuracy/analyzer/policy editor cases and all 236 existing Rust unit cases pass (f4c5ef77, #452).
- [x] Preserve raw restore-pending state before publication filtering. With min_severity=error, a real legacy client receives the final CS0029 automatically after SDK restore, without a hover/pull rescue or visible informational notice (ee42c874).
- [x] Implement and validate refresh_debounce_ms: actual F# source bursts coalesce into one standard refresh at live 100 → 1000 → 100 millisecond settings; the 2000 millisecond default is exposed, and negative/fractional/string/unknown controls reject without replacing the default or last valid policy. Two native sessions pass after genuine pre-fix rejection (bb2a3d92, #457).
- [x] Implement and validate auto_restore_on_open in both engines: four real F#/C# editor cases compare default restoration, explicit opt-out/live opt-in, and missing fixture-owned package caches against actual SDK effects. All four pass together after genuine pre-fix failures; 130 Common and 236 Rust cases also pass (33cfa885, #459). The broader restore gate and props-trigger guarantees remain tracked separately.

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
