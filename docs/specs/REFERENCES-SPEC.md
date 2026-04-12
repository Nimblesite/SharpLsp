# Find All References & Document Highlights Specification

**Parent:** [FORGE-SPEC.md](FORGE-SPEC.md)

## 1. Overview

Find All References locates every usage of a symbol across the entire solution. Document Highlights locates usages within the current document only (used for read/write highlighting on cursor move). Forge implements `textDocument/references` ([LSP 3.17 §3.17.10](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_references)) and `textDocument/documentHighlight` ([LSP 3.17 §3.17.5](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_documentHighlight)) for both C# and F# as equal first-class citizens.

Both methods are **P0** (launch blocker) and target Phase 2 delivery.

## 2. LSP Protocol

### 2.1 textDocument/references

```
method: textDocument/references
params: ReferenceParams {
    textDocument: TextDocumentIdentifier
    position: Position
    context: ReferenceContext {
        includeDeclaration: boolean
    }
}
```

```typescript
result: Location[] | null

interface Location {
    uri: DocumentUri;
    range: Range;
}
```

- `Location[]` containing every reference to the symbol across the workspace.
- When `context.includeDeclaration` is `true`, the declaration site is included in the result set.
- `null` when no symbol can be resolved at the given position.
- Results are sorted by file path, then by position within each file.

### 2.2 textDocument/documentHighlight

```
method: textDocument/documentHighlight
params: DocumentHighlightParams {
    textDocument: TextDocumentIdentifier
    position: Position
}
```

```typescript
result: DocumentHighlight[] | null

interface DocumentHighlight {
    range: Range;
    kind?: DocumentHighlightKind;
}

enum DocumentHighlightKind {
    Text = 1,
    Read = 2,
    Write = 3
}
```

- `DocumentHighlight[]` containing every occurrence of the symbol in the current document.
- Each highlight is annotated with `Read` or `Write` kind where determinable.
- `null` when no symbol can be resolved at the given position.

## 3. Request Routing

Both requests are **semantic** requests. The Rust host routes them to the appropriate sidecar based on document language.

| Step | Component | Action |
|---|---|---|
| 1 | Rust host | Receives request, identifies language from VFS |
| 2 | Rust host | Checks salsa cache for matching key (see §7) |
| 3 | Rust host | On cache miss, dispatches to C# sidecar (Roslyn) or F# sidecar (FCS) via IPC |
| 4 | Sidecar | Resolves symbol at position, finds all reference locations |
| 5 | Rust host | Caches result, returns LSP response to client |

The Rust host MAY use tree-sitter to pre-validate the position (reject whitespace, comments, string literals) and short-circuit with `null` before dispatching to the sidecar.

## 4. C# Implementation (Roslyn)

### 4.1 textDocument/references

1. Obtain `Document` from the current `Solution` snapshot for the given URI.
2. Get the source text and convert `(line, character)` to an absolute position via [`SourceText.Lines.GetPosition()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.text.textlinecollection.getposition).
3. Get `SemanticModel` via [`Document.GetSemanticModelAsync()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.document.getsemanticmodelasync).
4. Find the token at position via `SyntaxTree.GetRoot().FindToken()`.
5. Resolve the symbol via [`SemanticModel.GetSymbolInfo()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.semanticmodel.getsymbolinfo) on the token's parent node. Fall back to `GetDeclaredSymbol()` if on a declaration.
6. Call [`SymbolFinder.FindReferencesAsync(symbol, solution)`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.findusages.symbolfinder.findreferencesasync) to find all references across the solution.
7. Extract `ReferenceLocation` entries from each `ReferencedSymbol.Locations`.
8. If `context.includeDeclaration` is true, also include the symbol's declaration location(s) from `ReferencedSymbol.Definition.Locations`.
9. Map each location to `(filePath, line, character, endLine, endCharacter)`.

### 4.2 textDocument/documentHighlight

1. Steps 1–5 as in §4.1.
2. Call [`SymbolFinder.FindReferencesAsync(symbol, solution)`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.findusages.symbolfinder.findreferencesasync) scoped to the current document.
3. Filter results to only locations within the requested document.
4. Classify each reference as `Read` or `Write`:
   - Assignments, `out`/`ref` parameters, increment/decrement → `Write`
   - All other usages → `Read`
   - Declaration site → `Write`
5. Include the declaration location with `Write` kind.

### 4.3 Symbol Resolution Special Cases

| Symbol at Cursor | Behavior |
|---|---|
| Variable / parameter | All reads and writes in scope |
| Method / function | All call sites + declaration |
| Property | All get/set usages + declaration |
| Type (class, struct, enum, interface) | All type references + declaration |
| Constructor (`new Foo()`) | All constructor invocations; optionally include type references |
| Interface member | All implementations + all call sites on each implementation |
| Override method | References to all overrides + base virtual/abstract (via `OverriddenMethod` chain) |
| Partial class / method | References across all partial definitions |
| `nameof(Foo)` | Include in references to `Foo` |
| Generic type parameter `T` | All usages of that type parameter within the declaring scope |
| `using` alias | References to the alias + aliased type |
| Implicit references (attribute `[Foo]` → `FooAttribute`) | Include the implicit form |

## 5. F# Implementation (FCS)

### 5.1 textDocument/references

1. Get `FSharpCheckFileResults` for the document via `FSharpChecker.CheckFileInProject()`.
2. Call `GetSymbolUseAtLocation(line, col, lineText, names)` to obtain the `FSharpSymbolUse` at the cursor.
3. From the `FSharpSymbolUse.Symbol`, call [`GetUsesOfSymbolInFile()`](https://fsharp.github.io/fsharp-compiler-docs/) for document-scoped results.
4. For project-wide results, iterate all project files and call `GetAllUsesOfAllSymbolsInFile()` on each, filtering to the target symbol by `FSharpSymbol` equality.
5. If `context.includeDeclaration` is true, include the symbol's declaration range.
6. Map each `FSharpSymbolUse.Range` to LSP `Location`.

### 5.2 textDocument/documentHighlight

1. Steps 1–3 as in §5.1 (document-scoped only).
2. Classify each `FSharpSymbolUse`:
   - `FSharpSymbolUse.IsFromDefinition` → `Write`
   - `FSharpSymbolUse.IsFromPattern` → `Write`
   - All other usages → `Read`

### 5.3 F#-Specific Cases

| Symbol at Cursor | Behavior |
|---|---|
| Discriminated union case | All pattern matches + constructions of that case |
| Record field | All field accesses + record expressions using that field |
| Active pattern | All usages of the active pattern case |
| Computation expression keyword (`let!`, `do!`) | References to the CE builder method |
| Module function | All call sites across the project |
| Type abbreviation | All usages of the abbreviation |

## 6. Cross-Language References (P2)

When a C# project references an F# project (or vice versa), find-all-references must cross the language boundary.

| Scenario | Approach |
|---|---|
| C# symbol used in F# code | C# sidecar finds references in C# projects → Rust host also dispatches to F# sidecar for F# projects |
| F# symbol used in C# code | F# sidecar finds references in F# projects → Rust host also dispatches to C# sidecar for C# projects |

Cross-language references are a P2 feature targeting Phase 4. The Rust host merges results from both sidecars and deduplicates by location.

## 7. Caching Strategy

Reference results are cached via the [salsa](https://salsa-rs.github.io/salsa/) incremental computation database in the Rust host.

| Cache Key | Invalidation Trigger |
|---|---|
| `(document_uri, document_version, position, include_declaration)` for references | Any document change in the project |
| `(document_uri, document_version, position)` for document highlights | Document edit (version change) |

Document highlight results are cached more aggressively since they are scoped to a single file.

References results SHOULD be invalidated when any document in the solution changes, since references are solution-wide. The Rust host MAY use a coarse invalidation strategy (invalidate all reference caches on any edit) for simplicity.

Stale requests for superseded document versions MUST be cancelled.

## 8. Performance Requirements

| Metric | Target | Measurement |
|---|---|---|
| Find references (small solution, <100 files) | <500ms | Time to enumerate all references |
| Find references (medium solution, ~1000 files) | <2 seconds | Time to enumerate all references |
| Find references (large solution, ~5000 files) | <5 seconds | Time to enumerate all references |
| Document highlights | <100ms | Time to highlight all occurrences in current document |
| Cached reference lookup | <1ms | salsa cache hit |
| Tree-sitter pre-validation | <1ms | Whitespace/comment/literal rejection |

References may be returned incrementally via partial results (`partialResult` token) for large result sets to provide progressive UI feedback.

## 9. Error Handling

| Condition | Response |
|---|---|
| Position is whitespace or comment | Return `null` (no references) |
| Sidecar not ready / loading | Return `null` with `window/showMessage` notification |
| Symbol resolution fails | Return `null` |
| Sidecar crashes during request | Return `null`, trigger crash recovery (see FORGE-SPEC §5) |
| No references found (only declaration) | Return `[]` (empty array) if `includeDeclaration` is false; `[declaration]` if true |

Reference requests MUST NOT block, hang, or return errors to the client. On any failure, return `null`.

## 10. Wire Types (IPC)

### 10.1 Request

```csharp
[MessagePackObject]
public class ReferencesRequest
{
    [Key(0)] public string FilePath { get; set; }
    [Key(1)] public int Line { get; set; }
    [Key(2)] public int Character { get; set; }
    [Key(3)] public bool IncludeDeclaration { get; set; }
}
```

For document highlights, reuses `PositionRequest` (shared with hover/definition).

### 10.2 Response

Reuses `LocationListResult` from the definition spec for references:

```csharp
[MessagePackObject]
public class LocationListResult
{
    [Key(0)] public List<LocationResult> Locations { get; set; }
}
```

For document highlights, a new response type with highlight kind:

```csharp
[MessagePackObject]
public class DocumentHighlightResult
{
    [Key(0)] public int StartLine { get; set; }
    [Key(1)] public int StartCharacter { get; set; }
    [Key(2)] public int EndLine { get; set; }
    [Key(3)] public int EndCharacter { get; set; }
    [Key(4)] public int Kind { get; set; } // 1=Text, 2=Read, 3=Write
}

[MessagePackObject]
public class DocumentHighlightListResult
{
    [Key(0)] public List<DocumentHighlightResult> Highlights { get; set; }
}
```

### 10.3 IPC Methods

| IPC Method | LSP Method | Response Type |
|---|---|---|
| `textDocument/references` | `textDocument/references` | `LocationListResult` |
| `textDocument/documentHighlight` | `textDocument/documentHighlight` | `DocumentHighlightListResult` |

## 11. Competitive Parity Matrix

| Feature | VS | CDK | Rider | Forge Target | Priority |
|---|---|---|---|---|---|
| Find all references (in-source) | Y | Y | Y | Y | P0 |
| Find all references (metadata) | Y | N | Y | Y (P1) | P1 |
| Document highlights (read/write) | Y | Y | Y | Y | P0 |
| Find usages (advanced, grouped) | Y | N | Y | Y | P1 |
| Cross-language references (C# to F#) | N | N | Y* | Y | P2 |
| Reference count code lens | Y | Y | Y | Y | P1 |
| Partial result streaming | Y | N | Y | Y | P1 |

*\* Rider supports both languages but via proprietary code, not LSP.*
