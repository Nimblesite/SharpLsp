# Code Intelligence Plan

Remaining code intelligence features not covered by other plans.

## Signature Help

- [ ] Implement `textDocument/signatureHelp` handler in Rust host
- [ ] Wire C# sidecar to Roslyn `SignatureHelpService`
- [ ] Wire F# sidecar to FCS signature help
- [ ] Register `signatureHelpProvider` in server capabilities
- [ ] E2E test: signature help on method call returns parameter info

## Rename

Spec: [RENAME-SPEC.md](../specs/RENAME-SPEC.md). Rename is P0 and must cover every renameable code element, not only types.

### Rename Core

- [ ] Register `renameProvider` in server capabilities only after prepare and execute paths work
- [ ] Implement `textDocument/prepareRename` handler in Rust host
- [ ] Implement `textDocument/rename` handler in Rust host
- [ ] Add rename request/response IPC messages and MessagePack DTOs for both sidecars
- [ ] Convert sidecar edit sets into LSP `WorkspaceEdit`
- [ ] Add cancellation handling for stale rename requests
- [ ] Add structured tracing for prepare, execute, validation failures, edit counts, and latency

### C# Rename

- [ ] Resolve symbols with Roslyn semantic APIs for declarations and references
- [ ] Validate new names with Roslyn language services
- [ ] Wire C# sidecar to Roslyn `Renamer.RenameSymbolAsync`
- [ ] Map changed Roslyn documents to LSP text edits
- [ ] Preserve Roslyn-provided edits for `nameof`, XML doc references, partial declarations, overrides, and explicit interface implementations

### F# Rename

- [ ] Resolve `FSharpSymbolUse` at the cursor
- [ ] Validate new names for F# symbol kinds
- [ ] Wire F# sidecar to FCS rename/symbol-use pipeline
- [ ] Emit edits for every declaration and usage location in F# projects
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
- [ ] E2E test: rename after document edit uses latest VFS content
- [ ] E2E test: invalid new names are rejected
- [ ] E2E test: whitespace/comment/string/metadata positions are rejected
- [ ] E2E test: cross-language C# <-> F# public symbol rename
- [ ] E2E test: returned `WorkspaceEdit` has valid, non-overlapping LSP edits

## Editor Navigation

- [ ] Breadcrumb / scope bar support (documentSymbol hierarchy)
- [ ] Go to related files (e.g. .cs <-> .designer.cs, interface <-> implementation)
- [ ] Structural navigation (next/prev member)

## Misc

- [ ] Regex syntax highlighting in string literals
