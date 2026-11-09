# Find All References & Document Highlights Implementation Plan

**Spec:** [REFERENCES-SPEC.md](../specs/REFERENCES-SPEC.md)

## Context

Implements `textDocument/references` and `textDocument/documentHighlight` for C# (Roslyn) and F# (FCS). The Rust host routes requests to the appropriate sidecar, which resolves the symbol and returns all reference locations across the solution (references) or within the current document (highlights). Both methods are P0 features targeting Phase 2.

**Current status:** Core routing exists for the Rust host and both sidecars. The current `nav_cache.rs` `HashMap` is interim and nonconformant with [REFERENCES-SALSA]; solution-wide invalidation, salsa migration, cancellation, edge cases, E2E tests, and performance validation remain.

**Dependencies:** The definition infrastructure supplies symbol resolution, `PositionRequest`/`LocationListResult` wire types, tree-sitter pre-validation, and sidecar IPC routing. Its interim `nav_cache.rs` must not be treated as the target architecture. `SymbolFinder.FindReferencesAsync()` in Roslyn and `GetUsesOfSymbolInFile/Project()` in FCS are the primary APIs.

**Architecture notes:**
- References reuse the same request routing pattern as definition (Rust host → sidecar dispatch → salsa query result).
- `ReferencesRequest` extends `PositionRequest` with an `IncludeDeclaration` boolean.
- References return `LocationListResult` (reused from definition). Document highlights need a new `DocumentHighlightListResult` with read/write kind annotation.
- Document highlights are document-scoped; their memoization still belongs only to Rust-host salsa.

## TODO

### IPC Wire Types

- [x] Define `ReferencesRequest` MessagePack type in `SharpLsp.Sidecar.Common` (extends `PositionRequest` with `IncludeDeclaration`)
- [x] Define `DocumentHighlightResult` MessagePack type with `StartLine`, `StartCharacter`, `EndLine`, `EndCharacter`, `Kind`
- [x] Define `DocumentHighlightListResult` MessagePack type wrapping `List<DocumentHighlightResult>`
- [x] Register `textDocument/references` method in IPC message router (C# sidecar)
- [x] Register `textDocument/documentHighlight` method in IPC message router (C# sidecar)
- [x] Register `textDocument/references` method in IPC message router (F# sidecar)
- [x] Register `textDocument/documentHighlight` method in IPC message router (F# sidecar)
- [x] Add deserialization for `LocationListResult` (references) and `DocumentHighlightListResult` (highlights) in Rust IPC client

### Rust Host — textDocument/references

- [x] Declare `references_provider` in server capabilities (`build_capabilities()` in `main.rs`)
- [x] Add `textDocument/references` handler registration in LSP request dispatcher
- [x] Implement request routing: identify language from VFS, dispatch to correct sidecar
- [x] Pass `context.includeDeclaration` through to sidecar via `ReferencesRequest`
- [x] Add tree-sitter pre-validation to short-circuit on whitespace/comments/string literals
- [ ] Support partial result streaming for large result sets (P1)
- [x] Add the interim `nav_cache.rs` references map keyed by `(document_uri, document_version, position, include_declaration)` (nonconformant)
- [ ] Replace the interim map with a Rust-host salsa query and remove `nav_cache.rs`
- [ ] Make every solution document, project graph, and sidecar generation/readiness value a salsa input so any relevant change invalidates references; current code invalidates only entries requested from the edited URI
- [ ] Cancel superseded references requests and prevent late results from updating newer inputs
- [x] Add fallback behavior: return `null` when sidecar is unavailable or loading
- [x] Add tracing/logging for references request lifecycle (dispatch, cache hit/miss, result count, latency)

### Rust Host — textDocument/documentHighlight

- [x] Declare `document_highlight_provider` in server capabilities
- [x] Add `textDocument/documentHighlight` handler registration in LSP request dispatcher
- [x] Implement request routing: identify language from VFS, dispatch to correct sidecar
- [x] Add tree-sitter pre-validation to short-circuit on whitespace/comments/string literals
- [x] Add the interim `nav_cache.rs` highlight map keyed by `(document_uri, document_version, position)` (nonconformant)
- [ ] Replace the interim map with a Rust-host salsa query driven by document/version and sidecar-generation inputs
- [ ] Cancel superseded highlight requests; version invalidation alone does not cancel in-flight work
- [x] Add fallback behavior: return `null` when sidecar is unavailable or loading
- [x] Add tracing/logging for highlight request lifecycle

### C# Sidecar (Roslyn) — textDocument/references

- [x] Add `GetReferencesAsync()` method to `WorkspaceManager`
- [x] Register `textDocument/references` handler in `CSharpSidecar.cs`
- [x] Implement symbol resolution: `Document` → `SemanticModel` → `GetSymbolInfo()` with `GetDeclaredSymbol()` fallback
- [x] Call `SymbolFinder.FindReferencesAsync(symbol, solution)` for solution-wide references
- [x] Extract `ReferenceLocation` entries from each `ReferencedSymbol.Locations`
- [x] Include declaration locations when `IncludeDeclaration` is true
- [x] Map each reference to `LocationResult` (reuse existing type)
- [x] Handle override chains: include references to all overrides + base virtual/abstract — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`
- [x] Handle interface members: include references across all implementing classes — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`
- [x] Handle partial classes/methods: references across all partial definitions — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`; `includeDeclaration` listed only the first part before
- [x] Handle implicit references (`[Foo]` → `FooAttribute`) — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`

### C# Sidecar (Roslyn) — textDocument/documentHighlight

- [x] Add `GetDocumentHighlightsAsync()` method to `WorkspaceManager`
- [x] Register `textDocument/documentHighlight` handler in `CSharpSidecar.cs`
- [x] Implement symbol resolution (same pipeline as references)
- [x] Call `SymbolFinder.FindReferencesAsync()` scoped to the current document
- [x] Classify each reference as `Read` or `Write` based on syntax context
  - [x] Assignments, `out`/`ref` parameters, increment/decrement → `Write`
  - [x] Declaration site → `Write`
  - [x] All other usages → `Read`
- [x] Return `DocumentHighlightListResult`

### F# Sidecar (FCS) — textDocument/references

- [x] Add references handler to `FSharpSidecar.fs`
- [x] Implement symbol resolution via `GetSymbolUseAtLocation()`
- [x] For project-wide references: call `GetUsesOfSymbolInFile()`, filter to target symbol
- [x] Include declaration range when `IncludeDeclaration` is true
- [x] Map each `FSharpSymbolUse.Range` to `LocationResult`
- [x] Handle DU cases: pattern matches + constructions — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`
- [x] Handle record fields: field accesses + record expressions — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`
- [x] Handle active patterns: all usages of the active pattern case — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`

### F# Sidecar (FCS) — textDocument/documentHighlight

- [x] Add document highlight handler to `FSharpSidecar.fs`
- [x] Call `GetUsesOfSymbolInFile()` for document-scoped results
- [x] Classify each `FSharpSymbolUse`:
  - [x] `IsFromDefinition` → `Write`
  - [x] `IsFromPattern` → `Write`
  - [x] All other → `Read`
- [x] Return `DocumentHighlightListResult`

### Cross-Language References (P2)

- [x] Design cross-sidecar merge strategy in Rust host (dispatch to both sidecars, merge + deduplicate results)
- [x] Implement C# symbol → F# references (Rust host dispatches to F# sidecar for F# projects)
- [x] Implement F# symbol → C# references (Rust host dispatches to C# sidecar for C# projects)
- [ ] E2E test: cross-language references on a mixed C#/F# solution

### Testing — Rust E2E (`src/sharplsp/tests/lsp_e2e.rs`)

- [x] E2E test: C# find-all-references on method returns all call sites — `references.rs` `test_full_stack_references_on_method_returns_call_sites`
- [x] E2E test: C# find-all-references on class returns all type usages — `test_full_stack_references_on_class_returns_type_usages`
- [x] E2E test: C# find-all-references with `includeDeclaration: true` includes declaration — `test_full_stack_references_include_declaration_true`
- [x] E2E test: C# find-all-references with `includeDeclaration: false` excludes declaration — `test_full_stack_references_include_declaration_true` (both flags)
- [x] E2E test: C# find-all-references on interface member returns implementations + call sites — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`
- [x] E2E test: C# find-all-references on override returns references across override chain — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`
- [x] E2E test: C# find-all-references on whitespace/comment returns null — `test_references_on_comment_returns_null`
- [x] E2E test: C# find-all-references without sidecar returns null gracefully — `test_references_without_sidecar_returns_null`
- [x] E2E test: C# document-highlight returns read/write annotations — `test_full_stack_document_highlight_read_write`
- [x] E2E test: C# document-highlight on variable distinguishes reads from writes — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`
- [x] E2E test: F# find-all-references on function returns all call sites — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`
- [x] E2E test: F# find-all-references on DU case returns matches + constructions — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`
- [x] E2E test: F# find-all-references on record field returns accesses — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`
- [x] E2E test: F# document-highlight returns definition as Write, usages as Read — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp`
- [x] E2E test: references after document edit returns updated locations — `navigation_kinds.rs` `references_and_highlights_on_every_kind_are_exact_in_fsharp_and_csharp` (an unsaved F# call)
- [x] E2E test: references response has correct LSP structure — `test_full_stack_references_response_structure`

### Performance Validation

- [ ] Benchmark references latency on small solution (<100 files): target <500ms
- [ ] Benchmark references latency on medium solution (~1000 files): target <2s
- [ ] Benchmark document highlight latency: target <100ms
- [ ] Benchmark references salsa hit: target <1ms
- [ ] Validate tree-sitter pre-validation rejects non-symbol positions in <1ms
