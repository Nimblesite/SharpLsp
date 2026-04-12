# Find All References & Document Highlights Implementation Plan

**Spec:** [REFERENCES-SPEC.md](../specs/REFERENCES-SPEC.md)

## Context

Implements `textDocument/references` and `textDocument/documentHighlight` for C# (Roslyn) and F# (FCS). The Rust host routes requests to the appropriate sidecar, which resolves the symbol and returns all reference locations across the solution (references) or within the current document (highlights). Both methods are P0 features targeting Phase 2.

**Current status:** Completely unimplemented. No handler, no server capability, no sidecar method, no IPC message type exists for either feature.

**Dependencies:** The definition infrastructure (symbol resolution pipeline, `PositionRequest`/`LocationListResult` wire types, tree-sitter pre-validation, nav cache, sidecar IPC routing) is fully implemented and can be reused. `SymbolFinder.FindReferencesAsync()` in Roslyn and `GetUsesOfSymbolInFile/Project()` in FCS are the primary APIs.

**Architecture notes:**
- References reuse the same request routing pattern as definition (Rust host → sidecar dispatch → cache result).
- `ReferencesRequest` extends `PositionRequest` with an `IncludeDeclaration` boolean.
- References return `LocationListResult` (reused from definition). Document highlights need a new `DocumentHighlightListResult` with read/write kind annotation.
- Document highlights are document-scoped and cheaper than solution-wide references — cache more aggressively.

## TODO

### IPC Wire Types

- [ ] Define `ReferencesRequest` MessagePack type in `Forge.Sidecar.Common` (extends `PositionRequest` with `IncludeDeclaration`)
- [ ] Define `DocumentHighlightResult` MessagePack type with `StartLine`, `StartCharacter`, `EndLine`, `EndCharacter`, `Kind`
- [ ] Define `DocumentHighlightListResult` MessagePack type wrapping `List<DocumentHighlightResult>`
- [ ] Register `textDocument/references` method in IPC message router (both sidecars)
- [ ] Register `textDocument/documentHighlight` method in IPC message router (both sidecars)
- [ ] Add deserialization for `LocationListResult` (references) and `DocumentHighlightListResult` (highlights) in Rust IPC client

### Rust Host — textDocument/references

- [ ] Declare `references_provider` in server capabilities (`build_capabilities()` in `main.rs`)
- [ ] Add `textDocument/references` handler registration in LSP request dispatcher
- [ ] Implement request routing: identify language from VFS, dispatch to correct sidecar
- [ ] Pass `context.includeDeclaration` through to sidecar via `ReferencesRequest`
- [ ] Add tree-sitter pre-validation to short-circuit on whitespace/comments/string literals
- [ ] Support partial result streaming for large result sets (P1)
- [ ] Add references cache keyed by `(document_uri, document_version, position, include_declaration)`
- [ ] Invalidate references cache on any document change in the solution
- [ ] Add fallback behavior: return `null` when sidecar is unavailable or loading
- [ ] Add tracing/logging for references request lifecycle (dispatch, cache hit/miss, result count, latency)

### Rust Host — textDocument/documentHighlight

- [ ] Declare `document_highlight_provider` in server capabilities
- [ ] Add `textDocument/documentHighlight` handler registration in LSP request dispatcher
- [ ] Implement request routing: identify language from VFS, dispatch to correct sidecar
- [ ] Add tree-sitter pre-validation to short-circuit on whitespace/comments/string literals
- [ ] Add highlights cache keyed by `(document_uri, document_version, position)`
- [ ] Invalidate highlights cache on document edit (version change)
- [ ] Add fallback behavior: return `null` when sidecar is unavailable or loading
- [ ] Add tracing/logging for highlight request lifecycle

### C# Sidecar (Roslyn) — textDocument/references

- [ ] Add `GetReferencesAsync()` method to `WorkspaceManager`
- [ ] Register `textDocument/references` handler in `CSharpSidecar.cs`
- [ ] Implement symbol resolution: `Document` → `SemanticModel` → `GetSymbolInfo()` with `GetDeclaredSymbol()` fallback
- [ ] Call `SymbolFinder.FindReferencesAsync(symbol, solution)` for solution-wide references
- [ ] Extract `ReferenceLocation` entries from each `ReferencedSymbol.Locations`
- [ ] Include declaration locations when `IncludeDeclaration` is true
- [ ] Map each reference to `LocationResult` (reuse existing type)
- [ ] Handle override chains: include references to all overrides + base virtual/abstract
- [ ] Handle interface members: include references across all implementing classes
- [ ] Handle partial classes/methods: references across all partial definitions
- [ ] Handle implicit references (`[Foo]` → `FooAttribute`)

### C# Sidecar (Roslyn) — textDocument/documentHighlight

- [ ] Add `GetDocumentHighlightsAsync()` method to `WorkspaceManager`
- [ ] Register `textDocument/documentHighlight` handler in `CSharpSidecar.cs`
- [ ] Implement symbol resolution (same pipeline as references)
- [ ] Call `SymbolFinder.FindReferencesAsync()` scoped to the current document
- [ ] Classify each reference as `Read` or `Write` based on syntax context
  - [ ] Assignments, `out`/`ref` parameters, increment/decrement → `Write`
  - [ ] Declaration site → `Write`
  - [ ] All other usages → `Read`
- [ ] Return `DocumentHighlightListResult`

### F# Sidecar (FCS) — textDocument/references

- [ ] Add references handler to `FSharpSidecar.fs`
- [ ] Implement symbol resolution via `GetSymbolUseAtLocation()`
- [ ] For project-wide references: iterate all project files, call `GetAllUsesOfAllSymbolsInFile()`, filter to target symbol
- [ ] Include declaration range when `IncludeDeclaration` is true
- [ ] Map each `FSharpSymbolUse.Range` to `LocationResult`
- [ ] Handle DU cases: pattern matches + constructions
- [ ] Handle record fields: field accesses + record expressions
- [ ] Handle active patterns: all usages of the active pattern case

### F# Sidecar (FCS) — textDocument/documentHighlight

- [ ] Add document highlight handler to `FSharpSidecar.fs`
- [ ] Call `GetUsesOfSymbolInFile()` for document-scoped results
- [ ] Classify each `FSharpSymbolUse`:
  - [ ] `IsFromDefinition` → `Write`
  - [ ] `IsFromPattern` → `Write`
  - [ ] All other → `Read`
- [ ] Return `DocumentHighlightListResult`

### Cross-Language References (P2)

- [ ] Design cross-sidecar merge strategy in Rust host (dispatch to both sidecars, merge + deduplicate results)
- [ ] Implement C# symbol → F# references (Rust host dispatches to F# sidecar for F# projects)
- [ ] Implement F# symbol → C# references (Rust host dispatches to C# sidecar for C# projects)
- [ ] E2E test: cross-language references on a mixed C#/F# solution

### Testing — Rust E2E (`tests/lsp_e2e.rs`)

- [ ] E2E test: C# find-all-references on method returns all call sites
- [ ] E2E test: C# find-all-references on class returns all type usages
- [ ] E2E test: C# find-all-references with `includeDeclaration: true` includes declaration
- [ ] E2E test: C# find-all-references with `includeDeclaration: false` excludes declaration
- [ ] E2E test: C# find-all-references on interface member returns implementations + call sites
- [ ] E2E test: C# find-all-references on override returns references across override chain
- [ ] E2E test: C# find-all-references on whitespace/comment returns null
- [ ] E2E test: C# find-all-references without sidecar returns null gracefully
- [ ] E2E test: C# document-highlight returns read/write annotations
- [ ] E2E test: C# document-highlight on variable distinguishes reads from writes
- [ ] E2E test: F# find-all-references on function returns all call sites
- [ ] E2E test: F# find-all-references on DU case returns matches + constructions
- [ ] E2E test: F# find-all-references on record field returns accesses
- [ ] E2E test: F# document-highlight returns definition as Write, usages as Read
- [ ] E2E test: references after document edit returns updated locations
- [ ] E2E test: references response has correct LSP structure

### Performance Validation

- [ ] Benchmark references latency on small solution (<100 files): target <500ms
- [ ] Benchmark references latency on medium solution (~1000 files): target <2s
- [ ] Benchmark document highlight latency: target <100ms
- [ ] Benchmark references cache hit: target <1ms
- [ ] Validate tree-sitter pre-validation rejects non-symbol positions in <1ms
