# Go to Definition Specification `[DEFINITION-NAVIGATION]`

**Parent:** [SHARPLSP-SPEC.md](SHARPLSP-SPEC.md)

## Overview `[DEFINITION-OVERVIEW]`

Go to Definition navigates the user from a symbol usage to its declaration site. SharpLsp implements `textDocument/definition` ([LSP 3.17 §3.17.4](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_definition)), `textDocument/typeDefinition` ([§3.17.7](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_typeDefinition)), `textDocument/declaration` ([§3.17.3](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_declaration)), and `textDocument/implementation` ([§3.17.8](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_implementation)) for both C# and F# as equal first-class citizens.

## LSP Protocol `[DEFINITION-PROTOCOL]`

All four methods accept their corresponding `DefinitionParams`, `TypeDefinitionParams`, `DeclarationParams`, or `ImplementationParams`, each containing a `TextDocumentIdentifier` and `Position`.

### `textDocument/definition` `[DEFINITION-PROTOCOL-DEFINITION]`

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

### `textDocument/typeDefinition` `[DEFINITION-PROTOCOL-TYPE]`

Same response shape as `textDocument/definition`. Navigates to the type of the symbol at the cursor rather than the symbol itself. For example, on a variable `var x = new Foo()`, go-to-definition navigates to the constructor; go-to-type-definition navigates to `class Foo`.

### `textDocument/declaration` `[DEFINITION-PROTOCOL-DECLARATION]`

Same response shape. Navigates to the declaration site (interface member, partial declaration, abstract method) rather than the implementation.

### `textDocument/implementation` `[DEFINITION-PROTOCOL-IMPLEMENTATION]`

Same response shape. Navigates from an interface member or abstract/virtual method to all concrete implementations. Returns `Location[]` when multiple implementations exist.

## Request Routing `[DEFINITION-ROUTING]`

All four definition-family requests are **semantic** requests. The Rust host routes them to the appropriate sidecar based on document language.

| Step | Component | Action |
|---|---|---|
| 1 | Rust host | Receives request, identifies language from VFS |
| 2 | Rust host | Checks salsa cache for matching `(uri, version, position, method)` |
| 3 | Rust host | On cache miss, dispatches to C# sidecar (Roslyn) or F# sidecar (FCS) via IPC |
| 4 | Sidecar | Resolves symbol at position, finds definition location(s) |
| 5 | Rust host | Records the query result in salsa and returns the LSP response |

The Rust host MAY use tree-sitter to pre-validate the position (e.g., reject whitespace, comments, string literals) and short-circuit with `null` before dispatching to the sidecar.

Implementations: [semantic.rs](../../src/sharplsp/src/semantic.rs) and [syntax.rs](../../src/sharplsp/src/syntax.rs).

## C# Implementation (Roslyn) `[DEFINITION-CSHARP]`

### `textDocument/definition` `[DEFINITION-CSHARP-DEFINITION]`

1. Obtain `Document` from the current `Solution` snapshot for the given URI.
2. Get the source text and convert `(line, character)` to an absolute position via [`SourceText.Lines.GetPosition()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.text.textlinecollection.getposition).
3. Get `SemanticModel` via [`Document.GetSemanticModelAsync()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.document.getsemanticmodelasync).
4. Get the syntax root and find the token at position via [`SyntaxTree.GetRoot().FindToken()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.syntaxtree).
5. Resolve the symbol via [`SemanticModel.GetSymbolInfo()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.semanticmodel.getsymbolinfo) on the token's parent node.
6. If `GetSymbolInfo().Symbol` is null, fall back to `GetSymbolInfo().CandidateSymbols` and take the first candidate.
7. For each resolved symbol, extract source locations from [`ISymbol.Locations`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.isymbol.locations) where `Location.IsInSource` is true.
8. Map each `Location` back to `(filePath, line, character)` via the location's `SourceSpan` and `SyntaxTree`.

### `textDocument/typeDefinition` `[DEFINITION-CSHARP-TYPE]`

1. Steps 1–4 as above.
2. Get the type via [`SemanticModel.GetTypeInfo()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.semanticmodel.gettypeinfo).
3. Use `TypeInfo.Type` (or `TypeInfo.ConvertedType` as fallback).
4. Navigate to the type symbol's `Locations` as in step seven of [DEFINITION-CSHARP-DEFINITION].

### `textDocument/declaration` `[DEFINITION-CSHARP-DECLARATION]`

1. Resolve the symbol through steps one through six of [DEFINITION-CSHARP-DEFINITION].
2. For the resolved symbol, find the declaration that is an interface member or partial declaration:
   - If the symbol is an override, navigate to the base virtual/abstract member via `IMethodSymbol.OverriddenMethod` or `IPropertySymbol.OverriddenProperty`.
   - If the symbol implements an interface member, navigate to the interface member via [`ISymbol.FindImplementationForInterfaceMember()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.isymbol) (reverse lookup via `INamedTypeSymbol.Interfaces`).
   - If the symbol is a partial method/class, navigate to the defining partial declaration via [`IMethodSymbol.PartialDefinitionPart`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.imethodsymbol.partialdefinitionpart).

### `textDocument/implementation` `[DEFINITION-CSHARP-IMPLEMENTATION]`

1. Resolve the symbol through steps one through six of [DEFINITION-CSHARP-DEFINITION].
2. Use [`SymbolFinder.FindImplementationsAsync()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.findusages.symbolfinder.findimplementationsasync) to find all concrete implementations.
3. Return `Location[]` with one entry per implementation.

### Special Cases `[DEFINITION-CSHARP-CASES]`

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

### Metadata and Decompiled Source Navigation `[DEFINITION-CSHARP-METADATA]`

When a symbol's definition is in metadata (referenced assembly, NuGet package) rather than source:

1. **Phase 2 (MVP):** Return `null` — no navigation for metadata symbols.
2. **Phase 3 (P1):** Use [ICSharpCode.Decompiler](https://github.com/icsharpcode/ILSpy) to decompile the containing type, write it to a temporary file, and return a `Location` pointing to the decompiled source. Use the custom `sharplsp/decompileSource` method to serve decompiled content on demand.

Implementation: [DefinitionResolver.cs](../../src/sidecars/SharpLsp.Sidecar.CSharp/Workspace/DefinitionResolver.cs).

## F# Implementation (FCS) `[DEFINITION-FSHARP]`

### `textDocument/definition` `[DEFINITION-FSHARP-DEFINITION]`

1. Get `FSharpCheckFileResults` for the document via `FSharpChecker.CheckFileInProject()`.
2. Call [`GetDeclarationLocation(line, col, lineText, names)`](https://fsharp.github.io/fsharp-compiler-docs/) to obtain the declaration location.
3. `GetDeclarationLocation` returns `FindDeclResult`:
   - `FindDeclResult.DeclFound(range)` — return the location.
   - `FindDeclResult.DeclNotFound(reason)` — return `null`.
   - `FindDeclResult.ExternalDecl(assembly, fullName)` — decompilation target (Phase 3).

### `textDocument/typeDefinition` `[DEFINITION-FSHARP-TYPE]`

1. Get `FSharpCheckFileResults`.
2. Call `GetSymbolUseAtLocation(line, col, lineText, names)` to obtain `FSharpSymbolUse`.
3. From `FSharpSymbolUse.Symbol`, extract the type:
   - For `FSharpMemberOrFunctionOrValue`: use `.ReturnParameter.Type` or `.FullType`.
   - For `FSharpField`: use `.FieldType`.
   - For `FSharpEntity`: use the entity itself.
4. Navigate to the type's declaration range.

### `textDocument/declaration` `[DEFINITION-FSHARP-DECLARATION]`

1. Same as definition for most F# symbols (F# does not have partial classes).
2. For interface implementations, navigate to the interface member declaration.

### `textDocument/implementation` `[DEFINITION-FSHARP-IMPLEMENTATION]`

1. Use `GetSymbolUseAtLocation()` to find the symbol.
2. For abstract members in abstract classes or interfaces, search the project for implementing types.
3. Return `Location[]` for each implementation found.

### F#-Specific Cases `[DEFINITION-FSHARP-CASES]`

| Symbol at Cursor | Behavior |
|---|---|
| Discriminated union case | Navigate to the case declaration in the DU definition |
| Record field | Navigate to the field declaration in the record type |
| Active pattern | Navigate to the active pattern function definition |
| Computation expression keyword (`let!`, `do!`) | Navigate to the CE builder method |
| Type provider generated type | Navigate to the type provider definition (P2) |
| Module function | Navigate to the `let` binding |
| Pattern binding (`let (x, y) = ...`) | Navigate to the binding site |

Implementation: [FSharpWorkspace.fs](../../src/sidecars/SharpLsp.Sidecar.FSharp/FSharpWorkspace.fs).

## Cross-Language Navigation `[DEFINITION-CROSSLANG]`

The two directions are not symmetric. An F# project reads a referenced C# project compiled in
memory, so F# → C# navigation lands in the C# source, unbuilt. A C# project sees a referenced F#
project only as its built DLL, so C# → F# navigation lands in decompiled metadata-as-source. No
cross-sidecar symbol index exists in either direction.

| Scenario | Approach |
|---|---|
| F# code references C# type | The F# sidecar compiles the referenced C# project with Roslyn in memory, for the framework MSBuild picked for that reference, and FCS reads the image as a `PEReference` under MSBuild's own `-r:` ([SHARPLSP-ARCHITECTURE-PROJECTS-FSHARP-CSHARP-REFERENCES]). Definition, type definition and declaration resolve the symbol's documentation id in that Roslyn compilation and land in the `.cs` file and range that declares it. A C# reference the options do not carry keeps the DLL route below |
| F# code references a type in a DLL | `FSharpMetadataNavigator` decompiles the external symbol's type through the shared `MetadataDecompiler` and lands in the metadata-as-source file |
| C# code references F# type | Roslyn drops the F# `<ProjectReference>` (loads it as an empty stub); `WorkspaceManager.AddCrossLanguageMetadataReferences` re-attaches the built F# DLL as a metadata reference and removes the stub, then `MetadataNavigator` decompiles the resolved symbol. The F# project must be built for resolution to succeed |

Before a symbol is decompiled, the sidecar resolves what it stands for:

- **Abbreviations.** An F# type abbreviation (`string`, `int`, `seq<_>`) has no source of its own.
  Navigation follows `AbbreviatedType` to the entity it names (`System.String`) and decompiles
  that; FSharp.Core's abbreviations never land in FSharp.Core.
- **Type forwarders.** FCS names the assembly a symbol was compiled against, which for the BCL is a
  facade (`netstandard.dll`, `mscorlib.dll`) that only forwards the type. `MetadataDecompiler`
  resolves the type through the facade's type system and decompiles from the assembly that
  declares it (`System.Private.CoreLib.dll`), so the result is the type's source, not an empty
  forwarder.

Both directions compare paths only through the tier's path module
([SHARPLSP-ARCHITECTURE-PATHS]). Requirement: navigating from a use site in one language onto a
symbol defined in the other resolves to the declaring C# source (F# → C#) or to a decompiled
metadata-as-source location for that symbol's type (C# → F#), and never to `null` because the
target was an abbreviation or a forwarded type.

Source-to-source navigation from C# into an `.fs` file is not implemented; it requires a Rust-host
cross-sidecar symbol index.

## Caching Strategy `[DEFINITION-CACHE]`

Definition results are cached via the [salsa](https://salsa-rs.github.io/salsa/) incremental computation database in the Rust host.

| Cache Key | Invalidation Trigger |
|---|---|
| `(document_uri, document_version, position, method)` | Document edit (version change) |
| Semantic model snapshot | Any document change in the project |

The `method` component distinguishes between `definition`, `typeDefinition`, `declaration`, and `implementation` results for the same position.

The salsa query returns its memoized result when document, method, position, and version inputs match. Stale requests for superseded document versions MUST be cancelled. No second navigation cache is permitted.

## Performance Requirements `[DEFINITION-PERFORMANCE]`

| Metric | Target | Measurement |
|---|---|---|
| Definition latency (p50) | <100ms | Time from click/shortcut to navigation |
| Definition latency (p95) | <250ms | Time from click/shortcut to navigation |
| Cached definition lookup | <1ms | salsa cache hit |
| Tree-sitter pre-validation | <1ms | Whitespace/comment/literal rejection |
| Find implementations (100 impls) | <500ms | Time to enumerate all implementations |

## Error Handling `[DEFINITION-ERRORS]`

| Condition | Response |
|---|---|
| Position is whitespace or comment | Return `null` (no definition) |
| Sidecar not ready / loading | Return `null` with `window/showMessage` notification |
| Symbol resolution fails | Return `null` |
| Symbol is in metadata (no source, Phase 2) | Return `null` |
| Symbol is in metadata (Phase 3+) | Return decompiled source location |
| Sidecar crashes during request | Return `null` and trigger [SIDECAR-RECOVERY](SIDECAR-LIFECYCLE-SPEC.md) |
| Multiple partial definitions | Return `Location[]` with all partial sites |

Definition requests MUST NOT block, hang, or return errors to the client. On any failure, return `null`.

## Wire Types (IPC) `[DEFINITION-IPC]`

### Request `[DEFINITION-IPC-REQUEST]`

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

### Response `[DEFINITION-IPC-RESPONSE]`

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

### IPC Methods `[DEFINITION-IPC-METHODS]`

| IPC Method | LSP Method | Response Type |
|---|---|---|
| `textDocument/definition` | `textDocument/definition` | `LocationResult` or `LocationListResult` |
| `textDocument/typeDefinition` | `textDocument/typeDefinition` | `LocationResult` or `LocationListResult` |
| `textDocument/declaration` | `textDocument/declaration` | `LocationResult` or `LocationListResult` |
| `textDocument/implementation` | `textDocument/implementation` | `LocationListResult` |
