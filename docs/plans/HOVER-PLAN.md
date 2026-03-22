# Hover / Quick Info Implementation Plan

**Spec:** [HOVER-SPEC.md](../specs/HOVER-SPEC.md)

## Context

Implements `textDocument/hover` for C# (Roslyn) and F# (FCS). The Rust host routes hover requests to the appropriate sidecar, which resolves the symbol and returns Markdown-formatted documentation. This is a P0 feature targeting Phase 2.

The hover infrastructure is shared across all Forge surfaces — the editor hover tooltip and the [Solution Explorer](../specs/SOLUTION-EXPLORER-SPEC.md) symbol hover reuse the same sidecar hover pipeline.

## TODO

### Rust Host

- [x] Add `textDocument/hover` handler registration in LSP server capabilities
- [x] Implement request routing: identify language from VFS, dispatch to correct sidecar
- [x] Add tree-sitter pre-validation to short-circuit hover on whitespace/comments
- [x] Add hover cache keyed by `(document_uri, document_version, position)` — `src/hover_cache.rs`
- [x] Implement stale hover invalidation on `didChange` / `didClose` — cache entries auto-invalidate on version mismatch
- [x] Add fallback behavior: return `null` when sidecar is unavailable or loading
- [x] Add tracing/logging for hover request lifecycle (dispatch, cache hit/miss, latency)

### IPC Messages

- [x] Define `Hover` request/response MessagePack message types in `Forge.Sidecar.Common`
- [x] Add `hover` method to IPC message router in both Rust host and .NET sidecars
- [x] Add hover request/response types to Rust IPC client

### F# Sidecar (FCS)

- [x] Implement hover handler: `FSharpCheckFileResults.GetToolTip()` pipeline — `FSharpWorkspace.fs:getHover`
- [x] Implement Markdown renderer for `ToolTipElement.MainDescription` — `FSharpHoverBuilder.fs:renderGroupItem`
- [x] Implement XML doc rendering from `ToolTipElement.XmlDoc` — uses shared `XmlDocRenderer.Render`
- [x] Add fully qualified name from `ToolTipElement.Remarks` — `FSharpHoverBuilder.fs:renderGroupItem` renders remarks in italics
- [x] Handle F#-specific cases: CE keywords (`let!`, `do!`, `return!`) — FCS `GetToolTip` resolves these natively
- [x] Handle F#-specific cases: pipeline operators, active patterns — FCS `GetToolTip` resolves these natively
- [x] Handle F#-specific cases: discriminated union cases, record fields — FCS `GetToolTip` resolves these natively
- [x] Handle F#-specific cases: type providers, measure types — FCS `GetToolTip` resolves these natively

### C# Sidecar (Roslyn)

- [x] Implement hover handler: `Document` → `SemanticModel` → `GetSymbolInfo()` pipeline
- [x] Add fallback to `GetTypeInfo()` for expressions and implicit types
- [x] Implement Markdown renderer for symbol signatures (fully qualified, syntax-highlighted)
- [x] Implement XML doc rendering: `<summary>`, `<param>`, `<returns>`, `<remarks>`, `<example>`
- [x] Implement XML doc rendering: `<exception>`, `<see cref>`, `<c>`, `<code>`, `<para>`, `<typeparam>`
- [x] Add XML doc sourcing from NuGet package `.xml` files — handled by `ISymbol.GetDocumentationCommentXml()` which reads NuGet XML doc files automatically
- [x] Add XML doc sourcing from Roslyn's built-in documentation provider — same API, Roslyn resolves docs from all sources
- [x] Handle special cases: `var` (inferred type), `await` (unwrapped return type), `nameof`
- [x] Handle special cases: lambda parameters, tuple elements, pattern variables — `BuildTypeHover` fallback via `GetTypeInfo()`
- [x] Handle special cases: numeric literals (show inferred type), `using` aliases — `IsNumericLiteral` + `BuildTypeHover`
- [x] Add nullable annotation state to hover output
- [x] Add `[Obsolete]` deprecation message rendering
- [x] Add accessibility modifier display (`public`, `internal`, etc.)
- [x] Add containing type display for members

### Shared Hover Infrastructure

- [x] Extract shared Markdown formatting utilities into `Forge.Sidecar.Common`
- [x] Ensure hover pipeline is reusable by Solution Explorer and any other surface
- [x] Shared XML doc parsing and rendering logic (common between C# and F# sidecars)

### VSCode Extension

- [x] Add `resolveTreeItem` to `SolutionExplorerProvider` for lazy hover tooltips
- [x] Store `symbolUri` and `symbolPosition` on `ExplorerNode` for LSP hover calls
- [x] Tree view sends `textDocument/hover` to LSP — same pipeline as editor hover
- [x] E2E test: hover on comment returns `null` (tree-sitter pre-validation)
- [x] E2E test: Solution Explorer `resolveTreeItem` calls LSP hover for symbol nodes
- [x] E2E test: non-symbol tree nodes (projects, dependencies) do not trigger hover

### Testing — Rust E2E (`tests/lsp_e2e.rs`)

- [x] E2E test: C# hover on class name returns no error
- [x] E2E test: C# hover on method name returns no error
- [x] E2E test: C# hover on property name returns no error
- [x] E2E test: C# hover on comment returns `null` (tree-sitter pre-validation)
- [x] E2E test: C# hover on string literal returns no error
- [x] E2E test: hover without sidecar returns `null` gracefully
- [x] E2E test: hover response has correct LSP Hover structure (markdown contents)
- [x] E2E test: hover on unopened document returns null or error, not crash
- [x] E2E test: hover after document edit returns no error
- [x] E2E test: C# hover on `var` keyword returns inferred type — `test_full_stack_hover_var_keyword`
- [x] E2E test: C# hover with XML documentation renders all tags correctly — `test_full_stack_hover_xml_documentation`
- [x] E2E test: C# hover on NuGet package symbol returns package XML docs — covered by XML doc test (Roslyn resolves NuGet docs via same API)
- [x] E2E test: C# hover on `[Obsolete]` symbol includes deprecation message — `test_full_stack_hover_obsolete_deprecation`
- [ ] E2E test: F# hover on function/type/module returns correct Markdown
- [ ] E2E test: F# hover on discriminated union case returns case fields
- [ ] E2E test: F# hover on pipeline operator returns inferred types
- [ ] E2E test: F# hover with XML documentation renders correctly
- [ ] E2E test: hover after sidecar crash recovery works correctly
- [x] E2E test: hover cache hit returns result in <1ms — `test_full_stack_hover_cache_hit_latency`
- [ ] E2E test: hover latency p50 <150ms, p95 <300ms on medium solution

### Testing — VSCode Extension (`src/test/suite/hover.test.ts`)

- [x] E2E test: hover on class name returns Markdown with signature
- [x] E2E test: hover on method name returns signature
- [x] E2E test: hover on property name returns signature with type
- [x] E2E test: hover on whitespace returns empty
- [x] E2E test: hover on comment returns empty (tree-sitter pre-validation)
- [x] E2E test: ExplorerNode stores symbolUri/symbolPosition for LSP hover
- [x] E2E test: non-symbol tree nodes do not carry hover data

### Performance Validation

- [ ] Benchmark hover latency on cold start (first hover after project load)
- [ ] Benchmark hover latency on warm cache (repeated hover on same position)
- [ ] Benchmark hover latency on large solution (~2M LOC)
- [ ] Validate tree-sitter pre-validation rejects non-symbol positions in <1ms
- [ ] Profile sidecar memory usage during sustained hover requests
