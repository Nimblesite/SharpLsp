# CODEACTIONS-FIXALL-PLAN

Implementation plan for [CODEACTIONS-FIXALL-SPEC](../specs/CODEACTIONS-FIXALL-SPEC.md).
Bug: GitHub #577. F# lands before C# in every phase.

## Phase 1: Model And Rule Table (P0)

Implements [FIXALL-MODEL], [FIXALL-RULES], [FIXALL-RULES-TABLE].

- [ ] Generate C#, F# and Rust types from `docs/models/code-action-rules.td`; lint fails on stale output.
- [ ] Encode [FIXALL-RULES-TABLE] as data conforming to `FixRuleAssociation`; generate into each tier.
- [ ] Opposing-rule pairs (IDE0007↔IDE0008, IDE0160↔IDE0161, IDE0003↔IDE0009) in the table, not code.

## Phase 2: F# Batch Fixes (P0)

Implements [FIXALL-SCOPES] for F#.

- [ ] Batch form for remove unused open, simplify name, remove unused declaration, `_` prefix, add `new`.
- [ ] Scope resolution: containing binding/type (AST), document, project (`FSharpProjectOptions`), solution.
- [ ] Merge per-file edits from AST ranges; drop and report overlaps.
- [ ] Failing E2E first: two-project F# fixture, fix-all unused opens per scope (bug #577).

## Phase 3: C# Fix All (P0)

Implements [FIXALL-SCOPES] for C#.

- [ ] Detect `GetFixAllProvider()` + `GetSupportedFixAllScopes` per listed fix; record `EquivalenceKey`.
- [ ] Compute fix-all via `FixAllContext` for each scope; refactor-all where the provider supports it.
- [ ] Failing E2E first: "Use implicit type" across a real multi-project `.sln`.

## Phase 4: LSP Command Flow (P0)

Implements [FIXALL-LSP].

- [ ] One `Fix all: <title>…` action per fix-all-capable action; `data` carries `FixAllRequest`.
- [ ] `sharplsp.fixAll`: scope + enforce prompts via `window/showMessageRequest`.
- [ ] Cancellable `$/progress`; single `workspace/applyEdit` with `needsConfirmation` annotations.
- [ ] Post-apply diagnostic re-pull; report fixed/remaining counts; never silent.
- [ ] `source.fixAll.sharplsp` for `codeActionsOnSave` (document scope, enforced rules only).

## Phase 5: Enforcement Writers (P0)

Implements [FIXALL-ENFORCE].

- [ ] Lossless `.editorconfig` CST module in the host (parse/write, comments preserved).
- [ ] Target-file and section resolution; create root `.editorconfig` when absent.
- [ ] Detect overriding nested `.editorconfig`/sections and include them in the edit.
- [ ] `Directory.Build.props` XML DOM writer with list-property merge.
- [ ] TOML writer via existing serializer.
- [ ] Sidecar analyzer-config reload + `workspace/diagnostic/refresh` after apply.
- [ ] E2E: enforce IDE0007 → new explicit type is an editor error **and** a `dotnet build` error.
- [ ] E2E: enforce SLSPF0102 → new unused `open` is an error.

## Phase 6: VS Code UX (P1)

Implements [FIXALL-VSCODE].

- [ ] QuickPick: scopes + multi-select associated rules with severity; Signals state.
- [ ] `withProgress` bound to server progress; result message buttons.
- [ ] Code Style Rules view: rule id, severity, live violation count, `Fix all` / `Fix all and enforce`.
- [ ] VSIX E2E (desktop): full flow, preview confirm, Undo restores code and config.

## Phase 7: Performance And Docs (P1)

Implements [FIXALL-PERFORMANCE].

- [ ] Bench 10k occurrences / 200 files < 10 s; parallel per project.
- [ ] Website docs page (prose classes) + update [SHARPLSP-FEATURES-REFACTORING] table.
