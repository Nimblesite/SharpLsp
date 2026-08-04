# Find All References & Document Highlights Specification `[REFERENCES-SPEC]`

**Parent:** [SHARPLSP-SPEC.md](SHARPLSP-SPEC.md)

## Overview `[REFERENCES-OVERVIEW]`

`textDocument/references` ([LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_references)) locates symbol usages across the solution. `textDocument/documentHighlight` ([LSP 3.17](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_documentHighlight)) locates read/write usages in the current document. Both methods apply equally to C# and F#.

## LSP Protocol `[REFERENCES-PROTOCOL]`

### textDocument/references `[REFERENCES-PROTOCOL-FIND]`

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

### textDocument/documentHighlight `[REFERENCES-PROTOCOL-HIGHLIGHT]`

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

## Request Routing `[REFERENCES-ROUTING]`

| Step | Component | Action |
|---|---|---|
| 1 | Rust host | Receives request, identifies language from VFS |
| 2 | Rust host | Evaluates the salsa query for the request (see [REFERENCES-SALSA]) |
| 3 | Rust host | When the query is invalidated, dispatches to C# sidecar (Roslyn) or F# sidecar (FCS) via IPC |
| 4 | Sidecar | Resolves symbol at position, finds all reference locations |
| 5 | Rust host | Returns the salsa-derived LSP response to the client |

The Rust host MAY use tree-sitter to reject whitespace, comments, and string literals with `null` before sidecar dispatch.

Implementation anchors: Rust routing and DTO conversion live in [`src/sharplsp/src/semantic.rs`](../../src/sharplsp/src/semantic.rs); C# dispatch, symbol resolution, and wire types live in [`CSharpSidecar.cs`](../../src/sidecars/SharpLsp.Sidecar.CSharp/CSharpSidecar.cs), [`DefinitionResolver.cs`](../../src/sidecars/SharpLsp.Sidecar.CSharp/Workspace/DefinitionResolver.cs), and [`Messages.cs`](../../src/sidecars/SharpLsp.Sidecar.CSharp/Messages.cs); F# behavior and wire types live in [`FSharpReferences.fs`](../../src/sidecars/SharpLsp.Sidecar.FSharp/FSharpReferences.fs) and [`FSharpWire.fs`](../../src/sidecars/SharpLsp.Sidecar.FSharp/FSharpWire.fs). Coarse protocol coverage is in [`src/sharplsp/tests/e2e_modules/references.rs`](../../src/sharplsp/tests/e2e_modules/references.rs).

## C# Implementation (Roslyn) `[REFERENCES-CSHARP]`

### textDocument/references `[REFERENCES-CSHARP-FIND]`

1. Obtain `Document` from the current `Solution` snapshot for the given URI.
2. Get the source text and convert `(line, character)` to an absolute position via [`SourceText.Lines.GetPosition()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.text.textlinecollection.getposition).
3. Get `SemanticModel` via [`Document.GetSemanticModelAsync()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.document.getsemanticmodelasync).
4. Find the token at position via `SyntaxTree.GetRoot().FindToken()`.
5. Resolve the symbol via [`SemanticModel.GetSymbolInfo()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.semanticmodel.getsymbolinfo) on the token's parent node. Fall back to `GetDeclaredSymbol()` if on a declaration.
6. Call [`SymbolFinder.FindReferencesAsync(symbol, solution)`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.findusages.symbolfinder.findreferencesasync) to find all references across the solution.
7. Extract `ReferenceLocation` entries from each `ReferencedSymbol.Locations`.
8. If `context.includeDeclaration` is true, also include the symbol's declaration location(s) from `ReferencedSymbol.Definition.Locations`.
9. Map each location to `(filePath, line, character, endLine, endCharacter)`.

### textDocument/documentHighlight `[REFERENCES-CSHARP-HIGHLIGHT]`

1. Resolve the `Document` and symbol as in [REFERENCES-CSHARP-FIND].
2. Call [`SymbolFinder.FindReferencesAsync(symbol, solution)`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.findusages.symbolfinder.findreferencesasync) scoped to the current document.
3. Filter results to only locations within the requested document.
4. Classify each reference as `Read` or `Write`:
   - Assignments, `out`/`ref` parameters, increment/decrement → `Write`
   - All other usages → `Read`
   - Declaration site → `Write`
5. Include the declaration location with `Write` kind.

### Symbol Resolution Special Cases `[REFERENCES-CSHARP-RESOLUTION]`

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

## F# Implementation (FCS) `[REFERENCES-FSHARP]`

### textDocument/references `[REFERENCES-FSHARP-FIND]`

F# references MUST search every compile item in the loaded project; a file-local result is nonconforming.

1. Get `FSharpCheckFileResults` for the document via `FSharpChecker.CheckFileInProject()`.
2. Call `GetSymbolUseAtLocation(line, col, lineText, names)` to obtain the `FSharpSymbolUse` at the cursor.
3. From the `FSharpSymbolUse.Symbol`, call [`GetUsesOfSymbolInFile()`](https://fsharp.github.io/fsharp-compiler-docs/) for document-scoped results.
4. For project-wide results, iterate all project files and call `GetAllUsesOfAllSymbolsInFile()` on each, filtering to the target symbol by `FSharpSymbol` equality.
5. If `context.includeDeclaration` is true, include the symbol's declaration range.
6. Map each `FSharpSymbolUse.Range` to LSP `Location`.

### textDocument/documentHighlight `[REFERENCES-FSHARP-HIGHLIGHT]`

1. Resolve document-scoped symbol uses as in [REFERENCES-FSHARP-FIND].
2. Classify each `FSharpSymbolUse`:
   - `FSharpSymbolUse.IsFromDefinition` → `Write`
   - `FSharpSymbolUse.IsFromPattern` → `Write`
   - All other usages → `Read`

### F#-Specific Cases `[REFERENCES-FSHARP-CASES]`

| Symbol at Cursor | Behavior |
|---|---|
| Discriminated union case | All pattern matches + constructions of that case |
| Record field | All field accesses + record expressions using that field |
| Active pattern | All usages of the active pattern case |
| Computation expression keyword (`let!`, `do!`) | References to the CE builder method |
| Module function | All call sites across the project |
| Type abbreviation | All usages of the abbreviation |

## Cross-Language References `[REFERENCES-CROSS-LANGUAGE]`

When a C# project references an F# project (or vice versa), find-all-references must cross the language boundary.

| Scenario | Approach |
|---|---|
| C# symbol used in F# code | C# sidecar finds references in C# projects → Rust host also dispatches to F# sidecar for F# projects |
| F# symbol used in C# code | F# sidecar finds references in F# projects → Rust host also dispatches to C# sidecar for C# projects |

The Rust host merges results from both sidecars and deduplicates by location.

## Extended Results `[REFERENCES-EXTENSIONS]`

Metadata-symbol references, grouped find-usages results, and reference-count code lenses are supported extensions to the base methods. Large result sets SHOULD stream through `partialResult`; metadata and grouped results MUST retain the sorting, declaration-inclusion, and deduplication rules in this specification.

## Salsa Queries `[REFERENCES-SALSA]`

All references and document-highlight memoization MUST be implemented as Rust-host salsa queries. The editor, sidecars, handlers, and ad-hoc Rust maps MUST NOT cache these results.

| Query | Inputs that invalidate the result |
|---|---|
| `references(document_uri, position, include_declaration)` | Any solution document text/version, solution/project graph, language routing, or relevant sidecar generation/readiness change |
| `document_highlights(document_uri, position)` | Requested document text/version or relevant sidecar generation/readiness change |

Sidecar readiness and generation MUST be salsa inputs so a result produced while a sidecar is unavailable cannot remain memoized after recovery. A solution-wide edit invalidates reference results even when the requested URI did not change. Closing a document removes its inputs. Requests for superseded versions MUST be cancelled, and late results MUST NOT update salsa inputs for the newer version.

## Performance Requirements `[REFERENCES-PERFORMANCE]`

| Metric | Target | Measurement |
|---|---|---|
| Find references (small solution, <100 files) | <500ms | Time to enumerate all references |
| Find references (medium solution, ~1000 files) | <2 seconds | Time to enumerate all references |
| Find references (large solution, ~5000 files) | <5 seconds | Time to enumerate all references |
| Document highlights | <100ms | Time to highlight all occurrences in current document |
| Memoized reference lookup | <1ms | Salsa query hit |
| Tree-sitter pre-validation | <1ms | Whitespace/comment/literal rejection |

Large result sets MAY use the LSP `partialResult` token.

## Error Handling `[REFERENCES-ERRORS]`

| Condition | Response |
|---|---|
| Position is whitespace or comment | Return `null` (no references) |
| Sidecar not ready / loading | Return `null` with `window/showMessage` notification |
| Symbol resolution fails | Return `null` |
| Sidecar crashes during request | Return `null` and trigger [sidecar recovery](SIDECAR-LIFECYCLE-SPEC.md) |
| No references found (only declaration) | Return `[]` (empty array) if `includeDeclaration` is false; `[declaration]` if true |

Reference requests MUST NOT hang or return protocol errors to the client; failures return `null`.

## Wire Types (IPC) `[REFERENCES-IPC]`

### Request `[REFERENCES-IPC-REQUEST]`

The C# [`Messages.cs`](../../src/sidecars/SharpLsp.Sidecar.CSharp/Messages.cs) and F# [`FSharpWire.fs`](../../src/sidecars/SharpLsp.Sidecar.FSharp/FSharpWire.fs) definitions MUST encode identical keys.

| Type | MessagePack keys |
|---|---|
| `ReferencesRequest` | `0: FilePath string`, `1: Line int`, `2: Character int`, `3: IncludeDeclaration bool` |
| `PositionRequest` for highlights | `0: FilePath string`, `1: Line int`, `2: Character int` |

### Response `[REFERENCES-IPC-RESPONSE]`

| Type | MessagePack keys |
|---|---|
| `LocationListResult` | `0: Locations list<LocationResult>` |
| `DocumentHighlightResult` | `0: StartLine int`, `1: StartCharacter int`, `2: EndLine int`, `3: EndCharacter int`, `4: Kind int` (`Text=1`, `Read=2`, `Write=3`) |
| `DocumentHighlightListResult` | `0: Highlights list<DocumentHighlightResult>` |

### IPC Methods `[REFERENCES-IPC-METHODS]`

| IPC Method | LSP Method | Response Type |
|---|---|---|
| `textDocument/references` | `textDocument/references` | `LocationListResult` |
| `textDocument/documentHighlight` | `textDocument/documentHighlight` | `DocumentHighlightListResult` |
