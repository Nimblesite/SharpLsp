# Go to Definition Implementation Plan

**Spec:** [DEFINITION-SPEC.md](../specs/DEFINITION-SPEC.md)

## Context

Implements `textDocument/definition`, `textDocument/typeDefinition`, `textDocument/declaration`, and `textDocument/implementation` for C# (Roslyn) and F# (FCS). The Rust host routes requests to the appropriate sidecar, which resolves the symbol and returns one or more source locations. All four methods are P0 features targeting Phase 2.

All four C# navigation methods are implemented end-to-end: the Rust host registers all four capabilities, routes requests to the C# sidecar via MessagePack IPC, and the sidecar resolves symbols via Roslyn's `SemanticModel`, `GetSymbolInfo`, `GetTypeInfo`, and `SymbolFinder.FindImplementationsAsync`. Tree-sitter pre-validation short-circuits requests on comments, string literals, and whitespace. Multi-location responses work for `textDocument/implementation`. The `DefinitionResolver` (in `DefinitionResolver.cs`) supports `CandidateSymbols` fallback, `GetDeclaredSymbol` fallback for cursors on declarations, override-to-base navigation, interface impl-to-interface member navigation, and partial method definition parts.

**Test status**: All 17 E2E tests pass (6 syntax-only + 5 full-stack definition + 6 full-stack nav). Full-stack tests verify end-to-end through real Roslyn sidecar with `dotnet restore` workspaces.

The remaining work covers definition edge cases (partial classes, `nameof`, constructors), `DefinitionLink` support, salsa caching, F# support, metadata/decompiled source navigation, and performance benchmarking.

## TODO

### Rust Host

- [x] Add `textDocument/definition` handler registration in LSP server capabilities
- [x] Implement request routing: identify language from VFS, dispatch to correct sidecar
- [x] Add `textDocument/typeDefinition` handler registration and routing
- [x] Add `textDocument/declaration` handler registration and routing
- [x] Add `textDocument/implementation` handler registration and routing
- [x] Support multi-location responses (`Location[]`) for partial classes and implementations
- [ ] Support `DefinitionLink[]` response format for peek preview (advertise `linkSupport`)
- [x] Add tree-sitter pre-validation to short-circuit on whitespace/comments/string literals
- [ ] Add salsa cache key `(document_uri, document_version, position, method)` for definition results
- [ ] Implement stale request cancellation on document version change
- [x] Add fallback behavior: return `null` when sidecar is unavailable or loading
- [x] Add tracing/logging for definition request lifecycle (dispatch, cache hit/miss, latency)

### IPC Messages

- [x] Define `PositionRequest` MessagePack type in `Forge.Sidecar.Common` (shared with hover)
- [x] Define `LocationResult` MessagePack response type (single location)
- [x] Define `LocationListResult` MessagePack response type (multi-location)
- [x] Register `textDocument/definition` method in IPC message router
- [x] Register `textDocument/typeDefinition` method in IPC message router
- [x] Register `textDocument/declaration` method in IPC message router
- [x] Register `textDocument/implementation` method in IPC message router
- [x] Add multi-location response deserialization in Rust IPC client

### C# Sidecar (Roslyn) — textDocument/definition

- [x] Implement definition handler: `Document` → `SemanticModel` → `GetSymbolInfo()` pipeline
- [x] Add fallback to `CandidateSymbols` when `Symbol` is null
- [x] Extract source location from `ISymbol.Locations` where `IsInSource`
- [ ] Support multiple `Location` results for partial classes/methods
- [ ] Handle `nameof()` expressions (navigate to referenced symbol)
- [ ] Handle `using` aliases (navigate to aliased type)
- [ ] Handle constructor references (navigate to constructor declaration)
- [ ] Handle implicit declarations and generated source (source generators)

### C# Sidecar (Roslyn) — textDocument/typeDefinition

- [x] Implement type definition handler: `SemanticModel.GetTypeInfo()` pipeline
- [x] Use `TypeInfo.Type` with fallback to `TypeInfo.ConvertedType`
- [x] Navigate to the type symbol's source `Locations`
- [ ] Handle `var` (navigate to inferred type)
- [ ] Handle lambda parameters (navigate to inferred parameter type)
- [ ] Handle tuple elements (navigate to element type)

### C# Sidecar (Roslyn) — textDocument/declaration

- [x] Implement declaration handler
- [x] Navigate to interface member for interface implementations (`INamedTypeSymbol.Interfaces`)
- [x] Navigate to base virtual/abstract member for overrides (`OverriddenMethod`/`OverriddenProperty`)
- [x] Navigate to defining partial part (`PartialDefinitionPart`)

### C# Sidecar (Roslyn) — textDocument/implementation

- [x] Implement implementation handler via `SymbolFinder.FindImplementationsAsync()`
- [x] Return `LocationListResult` with all concrete implementations
- [x] Support interface → all implementing classes
- [x] Support abstract/virtual method → all overrides

### C# Sidecar (Roslyn) — Metadata Navigation (P1)

- [ ] Integrate ICSharpCode.Decompiler for metadata symbol navigation
- [ ] Decompile containing type to temporary file on definition request
- [ ] Serve decompiled source via custom `forge/decompileSource` method
- [ ] Cache decompiled sources to avoid repeated decompilation

### F# Sidecar (FCS) — textDocument/definition

- [ ] Implement definition handler: `FSharpCheckFileResults.GetDeclarationLocation()` pipeline
- [ ] Handle `FindDeclResult.DeclFound` (return location)
- [ ] Handle `FindDeclResult.DeclNotFound` (return null)
- [ ] Handle `FindDeclResult.ExternalDecl` (metadata — return null in Phase 2)
- [ ] Handle discriminated union case navigation
- [ ] Handle record field navigation
- [ ] Handle active pattern navigation
- [ ] Handle computation expression keyword navigation (`let!`, `do!`, `return!`)
- [ ] Handle module function navigation

### F# Sidecar (FCS) — textDocument/typeDefinition

- [ ] Implement type definition handler via `GetSymbolUseAtLocation()`
- [ ] Extract type from `FSharpMemberOrFunctionOrValue.FullType`
- [ ] Extract type from `FSharpField.FieldType`
- [ ] Navigate to type's declaration range

### F# Sidecar (FCS) — textDocument/declaration

- [ ] Implement declaration handler (same as definition for most F# symbols)
- [ ] Navigate to interface member for interface implementations

### F# Sidecar (FCS) — textDocument/implementation

- [ ] Implement implementation handler
- [ ] Search project for types implementing abstract members
- [ ] Return `LocationListResult` for all implementations

### Cross-Language Navigation (P2, Phase 4)

- [ ] Design cross-sidecar symbol index in Rust host
- [ ] Implement C# → F# definition resolution (C# sidecar → Rust host → F# sidecar)
- [ ] Implement F# → C# definition resolution (F# sidecar → Rust host → C# sidecar)
- [ ] Test cross-language navigation on a mixed C#/F# solution

### Testing — Rust E2E (`tests/lsp_e2e.rs`)

- [x] E2E test: C# go-to-definition on class name navigates to class declaration
- [x] E2E test: C# go-to-definition on method call navigates to method body
- [x] E2E test: C# go-to-definition on property access navigates to property declaration
- [ ] E2E test: C# go-to-definition on constructor call navigates to constructor
- [ ] E2E test: C# go-to-definition on partial class returns multiple locations
- [x] E2E test: C# go-to-definition on whitespace/comment returns null
- [x] E2E test: C# go-to-definition on string literal returns null
- [x] E2E test: C# go-to-definition without sidecar returns null gracefully
- [x] E2E test: C# go-to-definition response has correct LSP structure
- [x] E2E test: C# go-to-type-definition on variable navigates to type
- [ ] E2E test: C# go-to-type-definition on `var` navigates to inferred type
- [x] E2E test: C# go-to-declaration on override navigates to base member
- [x] E2E test: C# go-to-declaration on interface impl navigates to interface member
- [x] E2E test: C# go-to-implementation on interface method returns all implementations
- [x] E2E test: C# go-to-implementation on abstract method returns all overrides
- [ ] E2E test: F# go-to-definition on function navigates to `let` binding
- [ ] E2E test: F# go-to-definition on type navigates to type declaration
- [ ] E2E test: F# go-to-definition on DU case navigates to case declaration
- [ ] E2E test: F# go-to-definition on record field navigates to field declaration
- [ ] E2E test: F# go-to-definition on active pattern navigates to pattern function
- [ ] E2E test: F# go-to-type-definition on value navigates to type
- [ ] E2E test: F# go-to-implementation on abstract member returns implementations
- [x] E2E test: definition after document edit returns updated location
- [ ] E2E test: definition after sidecar crash recovery works correctly
- [ ] E2E test: definition cache hit returns result in <1ms
- [ ] E2E test: definition latency p50 <100ms, p95 <250ms on medium solution
- [x] E2E test: all four nav methods interleaved in single session

### Performance Validation

- [ ] Benchmark definition latency on cold start (first request after project load)
- [ ] Benchmark definition latency on warm cache (repeated request on same position)
- [ ] Benchmark definition latency on large solution (~2M LOC)
- [ ] Benchmark find-implementations latency with 100+ implementations
- [ ] Validate tree-sitter pre-validation rejects non-symbol positions in <1ms
- [ ] Profile sidecar memory usage during sustained definition requests
