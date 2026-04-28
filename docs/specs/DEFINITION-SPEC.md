# Go to Definition Specification

**Parent:** [SHARPLSP-SPEC.md](SHARPLSP-SPEC.md)

## 1. Overview

Go to Definition navigates the user from a symbol usage to its declaration site. SharpLsp implements `textDocument/definition` ([LSP 3.17 §3.17.4](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_definition)), `textDocument/typeDefinition` ([§3.17.7](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_typeDefinition)), `textDocument/declaration` ([§3.17.3](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_declaration)), and `textDocument/implementation` ([§3.17.8](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_implementation)) for both C# and F# as equal first-class citizens.

All four navigation methods are **P0** (launch blocker) and target Phase 2 delivery.

## 2. LSP Protocol

### 2.1 textDocument/definition

```
method: textDocument/definition
params: DefinitionParams {
    textDocument: TextDocumentIdentifier
    position: Position
}
```

```typescript
result: Definition | DefinitionLink[] | null

type Definition = Location | Location[]

interface DefinitionLink {
    originSelectionRange?: Range;
    targetUri: DocumentUri;
    targetRange: Range;
    targetSelectionRange: Range;
}
```

- Single `Location` when the symbol has exactly one definition site.
- `Location[]` when multiple definitions exist (partial classes, partial methods).
- `DefinitionLink[]` when the server advertises `definitionProvider: { linkSupport: true }` and the client supports it — provides richer origin/target ranges for peek preview.
- `null` when no definition can be resolved (unresolved symbol, error recovery).

### 2.2 textDocument/typeDefinition

```
method: textDocument/typeDefinition
params: TypeDefinitionParams {
    textDocument: TextDocumentIdentifier
    position: Position
}
```

Same response shape as `textDocument/definition`. Navigates to the type of the symbol at the cursor rather than the symbol itself. For example, on a variable `var x = new Foo()`, go-to-definition navigates to the constructor; go-to-type-definition navigates to `class Foo`.

### 2.3 textDocument/declaration

```
method: textDocument/declaration
params: DeclarationParams {
    textDocument: TextDocumentIdentifier
    position: Position
}
```

Same response shape. Navigates to the declaration site (interface member, partial declaration, abstract method) rather than the implementation.

### 2.4 textDocument/implementation

```
method: textDocument/implementation
params: ImplementationParams {
    textDocument: TextDocumentIdentifier
    position: Position
}
```

Same response shape. Navigates from an interface member or abstract/virtual method to all concrete implementations. Returns `Location[]` when multiple implementations exist.

## 3. Request Routing

All four definition-family requests are **semantic** requests. The Rust host routes them to the appropriate sidecar based on document language.

| Step | Component | Action |
|---|---|---|
| 1 | Rust host | Receives request, identifies language from VFS |
| 2 | Rust host | Checks salsa cache for matching `(uri, version, position, method)` |
| 3 | Rust host | On cache miss, dispatches to C# sidecar (Roslyn) or F# sidecar (FCS) via IPC |
| 4 | Sidecar | Resolves symbol at position, finds definition location(s) |
| 5 | Rust host | Caches result, returns LSP response to client |

The Rust host MAY use tree-sitter to pre-validate the position (e.g., reject whitespace, comments, string literals) and short-circuit with `null` before dispatching to the sidecar.

## 4. C# Implementation (Roslyn)

### 4.1 textDocument/definition

1. Obtain `Document` from the current `Solution` snapshot for the given URI.
2. Get the source text and convert `(line, character)` to an absolute position via [`SourceText.Lines.GetPosition()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.text.textlinecollection.getposition).
3. Get `SemanticModel` via [`Document.GetSemanticModelAsync()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.document.getsemanticmodelasync).
4. Get the syntax root and find the token at position via [`SyntaxTree.GetRoot().FindToken()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.syntaxtree).
5. Resolve the symbol via [`SemanticModel.GetSymbolInfo()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.semanticmodel.getsymbolinfo) on the token's parent node.
6. If `GetSymbolInfo().Symbol` is null, fall back to `GetSymbolInfo().CandidateSymbols` and take the first candidate.
7. For each resolved symbol, extract source locations from [`ISymbol.Locations`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.isymbol.locations) where `Location.IsInSource` is true.
8. Map each `Location` back to `(filePath, line, character)` via the location's `SourceSpan` and `SyntaxTree`.

### 4.2 textDocument/typeDefinition

1. Steps 1–4 as above.
2. Get the type via [`SemanticModel.GetTypeInfo()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.semanticmodel.gettypeinfo).
3. Use `TypeInfo.Type` (or `TypeInfo.ConvertedType` as fallback).
4. Navigate to the type symbol's `Locations` as in §4.1 step 7.

### 4.3 textDocument/declaration

1. Steps 1–6 as in §4.1.
2. For the resolved symbol, find the declaration that is an interface member or partial declaration:
   - If the symbol is an override, navigate to the base virtual/abstract member via `IMethodSymbol.OverriddenMethod` or `IPropertySymbol.OverriddenProperty`.
   - If the symbol implements an interface member, navigate to the interface member via [`ISymbol.FindImplementationForInterfaceMember()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.isymbol) (reverse lookup via `INamedTypeSymbol.Interfaces`).
   - If the symbol is a partial method/class, navigate to the defining partial declaration via [`IMethodSymbol.PartialDefinitionPart`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.imethodsymbol.partialdefinitionpart).

### 4.4 textDocument/implementation

1. Steps 1–6 as in §4.1.
2. Use [`SymbolFinder.FindImplementationsAsync()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.findusages.symbolfinder.findimplementationsasync) to find all concrete implementations.
3. Return `Location[]` with one entry per implementation.

### 4.5 Special Cases

| Symbol at Cursor | definition | typeDefinition | declaration | implementation |
|---|---|---|---|---|
| Variable (`var x = new Foo()`) | Variable declaration site | `Foo` class definition | Same as definition | N/A |
| Method call (`bar.Baz()`) | `Baz()` method body | Return type of `Baz()` | Interface/abstract `Baz()` | All overrides/implementations |
| Interface member | Interface declaration | Member return type | Same as definition | All implementing classes |
| Override method | Override declaration | Return type | Base virtual/abstract method | All sibling overrides |
| Constructor (`new Foo()`) | Constructor declaration | `Foo` class definition | Same as definition | N/A |
| Property access (`obj.Name`) | Property declaration | Property type definition | Interface property (if any) | All implementing properties |
| Partial class/method | First `partial` declaration | The type itself | Defining partial part | All partial parts |
| Generic type parameter (`T`) | Type parameter declaration | Constraint type (if any) | Same as definition | N/A |
| `using` alias (`using X = Y`) | Alias declaration | Aliased type `Y` | Same as definition | N/A |
| `nameof(Foo)` | `Foo` definition | `Foo` type definition | Same as definition | N/A |
| Metadata symbol (no source) | Decompiled source (P1) | Decompiled source (P1) | Same as definition | N/A |
| Implicitly declared symbol | Generated source (if available) | Type definition | Same as definition | N/A |

### 4.6 Metadata and Decompiled Source Navigation

When a symbol's definition is in metadata (referenced assembly, NuGet package) rather than source:

1. **Phase 2 (MVP):** Return `null` — no navigation for metadata symbols.
2. **Phase 3 (P1):** Use [ICSharpCode.Decompiler](https://github.com/icsharpcode/ILSpy) to decompile the containing type, write it to a temporary file, and return a `Location` pointing to the decompiled source. Use the custom `sharplsp/decompileSource` method to serve decompiled content on demand.

## 5. F# Implementation (FCS)

### 5.1 textDocument/definition

1. Get `FSharpCheckFileResults` for the document via `FSharpChecker.CheckFileInProject()`.
2. Call [`GetDeclarationLocation(line, col, lineText, names)`](https://fsharp.github.io/fsharp-compiler-docs/) to obtain the declaration location.
3. `GetDeclarationLocation` returns `FindDeclResult`:
   - `FindDeclResult.DeclFound(range)` — return the location.
   - `FindDeclResult.DeclNotFound(reason)` — return `null`.
   - `FindDeclResult.ExternalDecl(assembly, fullName)` — decompilation target (Phase 3).

### 5.2 textDocument/typeDefinition

1. Get `FSharpCheckFileResults`.
2. Call `GetSymbolUseAtLocation(line, col, lineText, names)` to obtain `FSharpSymbolUse`.
3. From `FSharpSymbolUse.Symbol`, extract the type:
   - For `FSharpMemberOrFunctionOrValue`: use `.ReturnParameter.Type` or `.FullType`.
   - For `FSharpField`: use `.FieldType`.
   - For `FSharpEntity`: use the entity itself.
4. Navigate to the type's declaration range.

### 5.3 textDocument/declaration

1. Same as definition for most F# symbols (F# does not have partial classes).
2. For interface implementations, navigate to the interface member declaration.

### 5.4 textDocument/implementation

1. Use `GetSymbolUseAtLocation()` to find the symbol.
2. For abstract members in abstract classes or interfaces, search the project for implementing types.
3. Return `Location[]` for each implementation found.

### 5.5 F#-Specific Cases

| Symbol at Cursor | Behavior |
|---|---|
| Discriminated union case | Navigate to the case declaration in the DU definition |
| Record field | Navigate to the field declaration in the record type |
| Active pattern | Navigate to the active pattern function definition |
| Computation expression keyword (`let!`, `do!`) | Navigate to the CE builder method |
| Type provider generated type | Navigate to the type provider definition (P2) |
| Module function | Navigate to the `let` binding |
| Pattern binding (`let (x, y) = ...`) | Navigate to the binding site |

## 6. Cross-Language Navigation (P2)

When a C# project references an F# project (or vice versa), go-to-definition must cross the language boundary. This requires coordination between both sidecars.

| Scenario | Approach |
|---|---|
| C# code references F# type | C# sidecar resolves symbol to metadata → Rust host dispatches to F# sidecar for source location |
| F# code references C# type | F# sidecar resolves to external declaration → Rust host dispatches to C# sidecar for source location |

Cross-language navigation is a P2 feature targeting Phase 4. It requires the Rust host to maintain a cross-sidecar symbol index.

## 7. Caching Strategy

Definition results are cached via the [salsa](https://salsa-rs.github.io/salsa/) incremental computation database in the Rust host.

| Cache Key | Invalidation Trigger |
|---|---|
| `(document_uri, document_version, position, method)` | Document edit (version change) |
| Semantic model snapshot | Any document change in the project |

The `method` component distinguishes between `definition`, `typeDefinition`, `declaration`, and `implementation` results for the same position.

The Rust host SHOULD cache the most recent result per document per method and return it immediately if the position and version match. Stale requests for superseded document versions MUST be cancelled.

## 8. Performance Requirements

| Metric | Target | Measurement |
|---|---|---|
| Definition latency (p50) | <100ms | Time from click/shortcut to navigation |
| Definition latency (p95) | <250ms | Time from click/shortcut to navigation |
| Cached definition lookup | <1ms | salsa cache hit |
| Tree-sitter pre-validation | <1ms | Whitespace/comment/literal rejection |
| Find implementations (100 impls) | <500ms | Time to enumerate all implementations |

## 9. Error Handling

| Condition | Response |
|---|---|
| Position is whitespace or comment | Return `null` (no definition) |
| Sidecar not ready / loading | Return `null` with `window/showMessage` notification |
| Symbol resolution fails | Return `null` |
| Symbol is in metadata (no source, Phase 2) | Return `null` |
| Symbol is in metadata (Phase 3+) | Return decompiled source location |
| Sidecar crashes during request | Return `null`, trigger crash recovery (see SHARPLSP-SPEC §5) |
| Multiple partial definitions | Return `Location[]` with all partial sites |

Definition requests MUST NOT block, hang, or return errors to the client. On any failure, return `null`.

## 10. Wire Types (IPC)

### 10.1 Request

Reuses `PositionRequest` shared with hover:

```csharp
[MessagePackObject]
public class PositionRequest
{
    [Key(0)] public string FilePath { get; set; }
    [Key(1)] public int Line { get; set; }
    [Key(2)] public int Character { get; set; }
}
```

### 10.2 Response

```csharp
[MessagePackObject]
public class LocationResult
{
    [Key(0)] public string FilePath { get; set; }
    [Key(1)] public int Line { get; set; }
    [Key(2)] public int Character { get; set; }
}
```

For multi-location responses (partial classes, implementations):

```csharp
[MessagePackObject]
public class LocationListResult
{
    [Key(0)] public List<LocationResult> Locations { get; set; }
}
```

### 10.3 IPC Methods

| IPC Method | LSP Method | Response Type |
|---|---|---|
| `textDocument/definition` | `textDocument/definition` | `LocationResult` or `LocationListResult` |
| `textDocument/typeDefinition` | `textDocument/typeDefinition` | `LocationResult` or `LocationListResult` |
| `textDocument/declaration` | `textDocument/declaration` | `LocationResult` or `LocationListResult` |
| `textDocument/implementation` | `textDocument/implementation` | `LocationListResult` |

## 11. Competitive Parity Matrix

| Feature | VS | CDK | Rider | SharpLsp Target | Priority |
|---|---|---|---|---|---|
| Go to definition (in-source) | ✓ | ✓ | ✓ | ✓ | P0 |
| Go to definition (metadata) | ✓ | ✓ | ✓ | ✓ | P1 |
| Go to type definition | ✓ | ✓ | ✓ | ✓ | P0 |
| Go to declaration | ✓ | ✓ | ✓ | ✓ | P0 |
| Go to implementation | ✓ | ✓ | ✓ | ✓ | P0 |
| Go to base member | ✓ | ✗ | ✓ | ✓ | P1 |
| Partial class navigation | ✓ | ✓ | ✓ | ✓ | P0 |
| Cross-language (C#↔F#) | ✗ | ✗ | ✓* | ✓ | P2 |
| Decompiled source navigation | ✓ | ✓ | ✓ | ✓ | P1 |
| Source generator output navigation | ✓ | ✓ | ✗ | ✓ | P2 |
| Peek definition (editor-side) | ✓ | ✓ | ✓ | ✓ (via DefinitionLink) | P0 |

*\* Rider supports both languages but via proprietary code, not LSP.*
