# Rename Specification

**Parent:** [forge-spec.md](forge-spec.md)

## [RENAME-OVERVIEW] Overview

Rename is a P0 semantic refactoring. Forge MUST implement `textDocument/prepareRename` and `textDocument/rename` for every renameable C# and F# code element, not just top-level types. A rename is incomplete until it updates every semantic reference in the loaded solution and returns a standards-compliant LSP `WorkspaceEdit`.

Rename is not a generic code action. Editors invoke it through the dedicated LSP rename flow, and Forge MUST advertise `renameProvider` only when both prepare and execute paths are available for the language.

## [RENAME-PROTOCOL] LSP Protocol

### [RENAME-PROTOCOL-PREPARE] textDocument/prepareRename

```
method: textDocument/prepareRename
params: TextDocumentPositionParams {
    textDocument: TextDocumentIdentifier
    position: Position
}
```

```typescript
result: Range | { range: Range; placeholder: string } | null
```

- Return the exact identifier range that will be renamed.
- Return the current symbol name as `placeholder`.
- Return `null` when the position is whitespace, trivia, a keyword that is not a renameable symbol, metadata-only source, generated source that cannot be edited, or a symbol kind Forge does not yet support.

### [RENAME-PROTOCOL-EXECUTE] textDocument/rename

```
method: textDocument/rename
params: RenameParams {
    textDocument: TextDocumentIdentifier
    position: Position
    newName: string
}
```

```typescript
result: WorkspaceEdit | null
```

- Return a `WorkspaceEdit` containing all edits needed across the solution.
- Validate `newName` against the target language and symbol kind before producing edits.
- Reject invalid identifiers with an LSP error response.
- Never rename unrelated string literals, comments, or text matches unless the compiler service reports them as semantic references for that symbol.

## [RENAME-COVERAGE] Code Element Coverage

Forge MUST support rename for these code element categories before rename is marked complete:

| Category | Required symbols |
|---|---|
| Types | C# classes, structs, interfaces, records, delegates; F# classes, structs, interfaces, records, object models, type abbreviations |
| Enums | C# enum types; F# enum types |
| Enum members | C# enum members; F# enum cases |
| Methods and functions | C# methods, local functions, operators, conversion operators; F# functions, members, local functions |
| Constructors | Constructor references through containing type rename; explicit constructor call sites must remain correct |
| Properties and indexers | C# properties and indexers; F# properties and indexers |
| Fields and events | C# fields, constants, events; F# fields, values, events |
| Local variables and pattern bindings | C# locals, foreach variables, catch variables, using variables, deconstruction variables, pattern variables; F# let bindings and pattern-bound identifiers |
| Parameters | C# method, constructor, local function, lambda, and delegate parameters; F# function, member, lambda, and pattern parameters |
| Namespaces and modules | C# namespaces and namespace aliases; F# modules and namespaces |
| Generic parameters | C# type and method type parameters; F# generic type parameters |
| Aliases | C# using aliases; F# type abbreviations and module aliases where supported by FCS |
| F# record fields | Record declaration fields plus construction, copy/update, pattern, and access sites |
| F# discriminated union cases | Union case declarations plus construction and pattern matching sites |
| F# active patterns | Active pattern declarations plus pattern usage sites |

## [RENAME-ROUTING] Request Routing

Rename requests are semantic requests.

| Step | Component | Action |
|---|---|---|
| 1 | Rust host | Receives prepare or rename request and identifies the document language from the VFS |
| 2 | Rust host | Rejects obviously invalid positions with tree-sitter pre-validation where safe |
| 3 | Rust host | Dispatches to C# sidecar or F# sidecar via MessagePack IPC |
| 4 | Sidecar | Resolves the semantic symbol at the requested position and validates renameability |
| 5 | Sidecar | Computes edits through compiler-service rename APIs |
| 6 | Rust host | Converts sidecar edits to LSP `WorkspaceEdit` and returns them to the client |

## [RENAME-CSHARP] C# Implementation

The C# sidecar MUST use Roslyn semantics.

1. Resolve the document from the current `Solution` snapshot.
2. Convert the LSP position to a Roslyn source position.
3. Resolve the symbol with `SemanticModel.GetDeclaredSymbol()` for declarations and `SemanticModel.GetSymbolInfo()` for references.
4. Validate renameability and the new identifier with Roslyn language services.
5. Use `Renamer.RenameSymbolAsync()` against the solution snapshot.
6. Convert changed Roslyn documents to file-scoped text edits.
7. Include edits for `nameof`, XML documentation references, partial declarations, explicit interface implementations, overrides, and generated symbol aliases when Roslyn reports them as rename locations.

## [RENAME-FSHARP] F# Implementation

The F# sidecar MUST use FCS symbol resolution and rename support rather than text matching.

1. Get checked file results for the current document.
2. Resolve the `FSharpSymbolUse` at the requested position.
3. Validate that the symbol kind is renameable and that the new name is valid F# syntax for that symbol kind.
4. Compute all symbol uses across the project or solution scope required for a safe rename.
5. Produce file-scoped text edits for every declaration and usage location.
6. Preserve F# file ordering semantics and avoid edits in generated or metadata-only files.

## [RENAME-CROSSLANGUAGE] Cross-Language Rename

Public symbols used across C# and F# project boundaries MUST be renamed across both languages before the rename feature is considered complete. The Rust host owns cross-sidecar orchestration:

- C# symbol renamed with F# references: C# sidecar computes C# edits; Rust host asks F# sidecar for F# usages and merges edits.
- F# symbol renamed with C# references: F# sidecar computes F# edits; Rust host asks C# sidecar for C# usages and merges edits.
- Conflicting or overlapping edits MUST fail the rename with a clear error instead of returning a partial edit.

## [RENAME-ERRORS] Error Handling

| Condition | Response |
|---|---|
| Position is whitespace, comment, or non-symbol trivia | `prepareRename` returns `null` |
| Symbol is metadata-only or generated-only | `prepareRename` returns `null` |
| Symbol kind is not implemented yet | `prepareRename` returns `null` and logs the missing kind |
| New name is invalid for the language or symbol kind | `textDocument/rename` returns an LSP error |
| Sidecar is loading or unavailable | Return `null`, log structured context, and trigger sidecar health handling |
| Rename would require edits outside writable workspace files | Return an LSP error |
| Cross-language edit merge conflicts | Return an LSP error and no partial edit |

## [RENAME-TESTS] Test Requirements

Every code element category in [RENAME-COVERAGE] MUST have coarse e2e coverage. Tests must use real projects and solution files, not mocks.

Required e2e scenarios:

- `prepareRename` returns the correct range and placeholder for each code element category.
- `rename` updates declarations and references across multiple files.
- Rename after document edit uses the latest VFS content.
- Invalid new names are rejected.
- Whitespace, comments, string literals, and metadata-only positions are rejected.
- Cross-language public symbol rename updates C# and F# references in the same solution.
- Returned `WorkspaceEdit` uses valid LSP ranges and does not contain overlapping edits.

## [RENAME-PERFORMANCE] Performance Requirements

| Metric | Target |
|---|---|
| `prepareRename` | <100ms p95 on a warm semantic model |
| Small solution rename (<100 files) | <500ms |
| Medium solution rename (~1000 files) | <2 seconds |
| Large solution rename (~5000 files) | <5 seconds, with cancellation support |
| Tree-sitter pre-validation | <1ms |

Rename requests MUST support LSP cancellation. Stale rename computation for superseded document versions MUST be cancelled before returning edits.
