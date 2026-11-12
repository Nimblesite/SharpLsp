# Code Intelligence Plan

Remaining code intelligence features not covered by other plans.

## Signature Help

- [x] Implement `textDocument/signatureHelp` handler in Rust host — `signature_help.rs`
- [x] Wire C# sidecar to Roslyn semantic-model overload resolution — `SignatureHelpResolver.cs`, matching [SHARPLSP-FEATURES-INTELLIGENCE-SIGNATURE-HELP]
- [x] Wire F# sidecar to FCS signature help — `FSharpSignature.fs`
- [x] Register `signatureHelpProvider` in server capabilities
- [x] E2E test: signature help on method call returns parameter info — `SignatureHelpEndToEndTests`, the F# sidecar IPC constructor test, and published v0.32.1 F# LSP verification
- [x] F# active parameter follows the caret across nested calls, string commas and unsaved changes — `FSharpSignatureParameterTests`, [FS-SIGHELP], issue #552
- [x] F# named arguments select their declared parameter when reordered or mixed with positional arguments — `FSharpSignatureParameterTests`, [SHARPLSP-FEATURES-INTELLIGENCE-SIGNATURE-HELP], issue #552
- [x] F# variadic arguments stay on the final `ParamArray` parameter, including unfinished calls — `FSharpSignatureParameterTests`, [SHARPLSP-FEATURES-INTELLIGENCE-SIGNATURE-HELP], issue #552
- [x] F# multiline calls resolve their enclosing callee from the cached syntax tree, including punctuation literals and unsaved edits — `FSharpSignatureParameterTests`, [FS-SIGHELP], issue #555

## Rename

Spec: [RENAME-SPEC.md](../specs/RENAME-SPEC.md). Rename is P0 and must cover every renameable code element, not only types.

### Rename Core

- [x] Register `renameProvider` in server capabilities only after prepare and execute paths work — `capabilities.rs`
- [x] Implement `textDocument/prepareRename` handler in Rust host — `semantic/rename.rs`
- [x] Implement `textDocument/rename` handler in Rust host — `semantic/rename.rs`
- [x] Add rename request/response IPC messages and MessagePack DTOs for both sidecars — C# `Messages.cs`, F# `FSharpWire.fs`
- [x] Convert sidecar edit sets into LSP `WorkspaceEdit` — `semantic/rename.rs`
- [ ] Add cancellation handling for stale rename requests
  - [x] F# rename carries the request token through file, project, usage-location and indexer checks; a held-source IPC regression cancels before the source is released.
  - [x] F# cross-language rename carries cancellation through symbol scans, source reads and projected-source fallback; a held-source IPC regression cancels before release.
  - [ ] Verify host-side superseded-version cancellation before checking the parent item.
- [ ] Add structured tracing for prepare, execute, validation failures, edit counts, and latency

The five completed core items were verified against the latest published v0.32.1 host and its bundled C# and F# sidecars on 2026-11-09. The native `test_full_stack_prepare_rename_returns_range`, `test_full_stack_rename_renames_symbol_across_usages` and `test_full_stack_fsharp_rename` cases all passed, and the released initialize response advertised `renameProvider.prepareProvider = true`.

### C# Rename

- [x] Resolve symbols with Roslyn semantic APIs for declarations and references — `WorkspaceManager.Rename.cs`, `RefactorEndToEndTests`, [RENAME-CSHARP]
- [ ] Validate new names with Roslyn language services
- [x] Wire C# sidecar to Roslyn `Renamer.RenameSymbolAsync` — `WorkspaceManager.Rename.cs`, `RefactorEndToEndTests`, [RENAME-CSHARP]
- [x] Map changed Roslyn documents to LSP text edits — `WorkspaceManager.Rename.cs`, the native C# session edit-application assertions, [RENAME-APPLY]
- [ ] Preserve Roslyn-provided edits for `nameof`, XML doc references, partial declarations, overrides, and explicit interface implementations

### F# Rename

- [x] Resolve `FSharpSymbolUse` at the cursor — `FSharpRename.fs`, `FSharpRenameSemanticTests`, [RENAME-FSHARP-PREPARE]
- [ ] Validate new names for F# symbol kinds
- [x] Wire F# sidecar to FCS rename/symbol-use pipeline — `FSharpRename.fs`, `FSharpReferences.fs`, `FSharpRenameSemanticTests`, [RENAME-FSHARP-APPLY]
- [x] Emit edits for every declaration and usage location in F# projects — `FSharpRenameSemanticTests` asserts exact declaration and usage edits across two ordered files, [RENAME-FSHARP-APPLY]
- [ ] Preserve F# file-ordering semantics during project-wide rename

### Rename Code Element Coverage

- [ ] Classes, structs, interfaces, records, and delegates
- [ ] Enums
- [ ] Enum members
- [ ] Methods, functions, local functions, operators, and conversion operators
- [ ] Constructors via containing type rename
- [ ] Properties and indexers
- [ ] Fields and events
- [ ] Local variables and pattern/deconstruction bindings
- [ ] Parameters and lambda parameters
- [ ] Namespaces and modules
- [ ] Generic type parameters
- [ ] Aliases and type abbreviations
- [ ] F# record fields
- [ ] F# discriminated union cases
- [ ] F# active patterns

### Rename Tests

- [ ] E2E test: `prepareRename` range and placeholder for every code element category
- [ ] E2E test: rename updates declarations and references across files
- [x] E2E test: rename after document edit uses latest VFS content — `lsp-rename-edge.test.ts` and `fsharp-lsp-rename-edge.test.ts` prepare, apply, reverse and undo renames of unsaved C# and F# bindings, [RENAME-TESTS]
- [x] E2E test: invalid new names are rejected — `RefactorEndToEndTests` requires an error and no payload for six invalid C# names; `FSharpNavigationEdgeTests` requires the compiler-backed F# refusal, [RENAME-ERRORS]. The #559 regression also passed a real LSP probe with the fixed C# engine; released v0.32.1 still has the bug.
- [ ] E2E test: whitespace/comment/string/metadata positions are rejected
- [x] E2E test: cross-language C# <-> F# public symbol rename — `fsharp-lsp-cross-language-rename.test.ts` checks public types and properties in both directions, exact edits in both files, apply/reverse, rebuild and diagnostics, [RENAME-CROSSLANGUAGE]
- [ ] E2E test: returned `WorkspaceEdit` has valid, non-overlapping LSP edits

The unsaved C# case, three F# name variants and four cross-language type/property cases passed in the Linux `lsp` and `fsharp` jobs at `997a1734` on 2026-11-10. The code-element checklist above tracks the remaining category-wide coverage. [CI run](https://github.com/Nimblesite/SharpLsp/actions/runs/42712062747)

## Editor Navigation

- [ ] Breadcrumb / scope bar support (documentSymbol hierarchy)
- [ ] Go to related files (e.g. .cs <-> .designer.cs, interface <-> implementation)
- [ ] Structural navigation (next/prev member)

## Misc

- [ ] Regex syntax highlighting in string literals
