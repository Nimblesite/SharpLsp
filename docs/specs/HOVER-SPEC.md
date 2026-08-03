# [HOVER-SPEC] Hover / Quick Info Specification

**Parent:** [SHARPLSP-SPEC.md](SHARPLSP-SPEC.md)

## [HOVER-OVERVIEW] Overview

SharpLsp implements P0 `textDocument/hover` ([LSP 3.17 §3.17.5](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_hover)) for C# and F#.

## [HOVER-PROTOCOL] LSP Protocol

### [HOVER-PROTOCOL-REQUEST] Request

```
method: textDocument/hover
params: HoverParams {
    textDocument: TextDocumentIdentifier
    position: Position
}
```

### [HOVER-PROTOCOL-RESPONSE] Response

```
result: Hover | null
```

```typescript
interface Hover {
    contents: MarkupContent;
    range?: Range;
}
```

- `contents` — Markdown-formatted string containing the symbol signature, documentation, and metadata.
- `range` — The range of the hovered token. Editors use this to highlight the symbol while the tooltip is visible.

SharpLsp MUST return `MarkupContent` with `kind: "markdown"`. Plain-text fallback is not supported — all LSP 3.17 clients support Markdown.

## [HOVER-ROUTING] Request Routing

Hover is a **semantic** request. The Rust host routes it to the appropriate sidecar based on document language.

Implementations: [semantic.rs](../../src/sharplsp/src/semantic.rs), [CSharpHoverBuilder.cs](../../src/sidecars/SharpLsp.Sidecar.CSharp/Hover/CSharpHoverBuilder.cs), [FSharpHoverBuilder.fs](../../src/sidecars/SharpLsp.Sidecar.FSharp/Hover/FSharpHoverBuilder.fs), and the [C# hover end-to-end tests](../../src/sidecars/SharpLsp.Sidecar.CSharp.Tests/HoverEndToEndTests.cs).

| Step | Component | Action |
|---|---|---|
| 1 | Rust host | Receives `textDocument/hover`, identifies language from VFS |
| 2 | Rust host | Dispatches to C# sidecar (Roslyn) or F# sidecar (FCS) via IPC |
| 3 | Sidecar | Resolves symbol at position, builds Markdown response |
| 4 | Rust host | Returns `Hover` result to client |

The Rust host MAY use tree-sitter to pre-validate the hovered position (e.g., skip hover for whitespace/comments) and short-circuit with `null` before dispatching to the sidecar.

## [HOVER-CSHARP] C# Implementation

### [HOVER-CSHARP-RESOLUTION] Symbol Resolution

1. Obtain `Document` from the current `Solution` snapshot for the given URI.
2. Get `SemanticModel` via [`Document.GetSemanticModelAsync()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.document.getsemanticmodelasync).
3. Find the syntax token at position via [`SyntaxTree.GetRoot().FindToken()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.syntaxtree).
4. Resolve symbol via [`SemanticModel.GetSymbolInfo()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.semanticmodel.getsymbolinfo) on the token's parent node.
5. If `GetSymbolInfo()` returns no symbol, fall back to [`SemanticModel.GetTypeInfo()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.semanticmodel.gettypeinfo) for implicit types and expressions.
6. For keywords (`var`, `await`, `async`, `nameof`, etc.), provide keyword-specific documentation.

### [HOVER-CSHARP-RENDERING] Markdown Rendering

The hover response MUST include:

| Section | Content | Required |
|---|---|---|
| Signature | Fully qualified symbol signature with syntax highlighting | Yes |
| Containing type | `ContainingType.Name` for members | Yes (if applicable) |
| XML documentation | `<summary>`, `<param>`, `<returns>`, `<remarks>`, `<example>` | Yes (if present) |
| Exceptions | `<exception>` tags | Yes (if present) |
| Nullability | Nullable annotation state | Yes (if nullable enabled) |
| Accessibility | `public`, `internal`, `protected`, etc. | Yes |
| Deprecation | `[Obsolete]` message | Yes (if present) |

#### [HOVER-CSHARP-RENDERING-XML] XML Documentation Rendering

- `<summary>` — Rendered as the primary description paragraph.
- `<param name="x">` — Rendered as a parameter list with descriptions.
- `<returns>` — Rendered after parameters.
- `<remarks>` — Rendered as an additional section.
- `<example>` — Rendered in a fenced code block.
- `<exception cref="T">` — Rendered as "Exceptions: T — description".
- `<see cref="T"/>` — Rendered as an inline code reference.
- `<c>` — Rendered as inline code.
- `<code>` — Rendered as a fenced code block.
- `<para>` — Rendered as a paragraph break.
- `<typeparam name="T">` — Rendered alongside generic type parameters.

XML docs are sourced from:

1. Source code `///` comments (highest priority).
2. XML documentation files from NuGet packages (`.xml` files alongside assemblies).
3. Roslyn's built-in documentation provider as fallback.

### [HOVER-CSHARP-CASES] Special Cases

| Hover Target | Behavior |
|---|---|
| `var` keyword | Show inferred type with full signature |
| `await` keyword | Show the unwrapped `Task<T>` return type |
| `nameof()` | Show the referenced symbol |
| String literals | No hover (return `null`) |
| Numeric literals | Show the inferred numeric type |
| Lambda parameters | Show inferred parameter types |
| Tuple elements | Show element names and types |
| Pattern variables | Show the pattern-matched type |
| Preprocessor directives | Show directive documentation |
| `using` alias | Show the aliased type |

## [HOVER-FSHARP] F# Implementation

### [HOVER-FSHARP-RESOLUTION] Symbol Resolution

1. Get `FSharpCheckFileResults` for the document via `FSharpChecker.CheckFileInProject()`.
2. Call `GetToolTip(line, col, lineText, names, tokenTag)` to obtain `ToolTipText`.
3. `ToolTipText` contains `ToolTipElement[]`, each with a structured layout and XML documentation.

### [HOVER-FSHARP-RENDERING] Markdown Rendering

F# hover follows the same Markdown structure as C#:

| Section | Content | Source |
|---|---|---|
| Signature | F# type signature | `ToolTipElement.MainDescription` |
| Documentation | XML doc summary | `ToolTipElement.XmlDoc` |
| Full name | Fully qualified name | `ToolTipElement.Remarks` |
| Constraints | Generic constraints | Extracted from signature |
| Union cases | Case fields and types | `ToolTipElement` for DU cases |

### [HOVER-FSHARP-CASES] F#-Specific Cases

| Hover Target | Behavior |
|---|---|
| Computation expression keywords (`let!`, `do!`, `return!`) | Show the CE builder method |
| Pipeline operators (`\|>`, `>>`) | Show inferred function types |
| Active patterns | Show the pattern signature and documentation |
| Type providers | Show the provided type and its properties |
| Measure types | Show the unit of measure annotation |
| Discriminated union cases | Show case fields with types |
| Record fields | Show field type and containing record |

### [HOVER-FSHARP-OVERLAY] Live-Buffer Resolution

Hover MUST resolve against the editor's **in-memory buffer**, not the on-disk file. The Rust host routes `textDocument/didOpen` and `didChange` by document language to the owning sidecar. The F# sidecar keeps an authoritative document-state overlay keyed by absolute file path, and every per-file analysis (hover, completion, signature help, and others) reads from it, falling back to disk only when no open buffer exists. This overlay is state, not memoization. The C# sidecar updates its Roslyn workspace in place on `didChange`.

#### [HOVER-FSHARP-OVERLAY-CHECK] Canonical Check Funnel

Every per-file FCS analysis (hover, completion, diagnostics, signature help, inlay hints, code fixes, and file ordering) MUST use the canonical `parseAndCheckOnce` operation through its `checkFileWithParse` or `checkFile` view instead of calling `FSharpChecker.ParseAndCheckFileInProject` directly. This centralizes overlay-aware source resolution and `FSharpCheckFileAnswer` handling, ensures checks use the latest `didChange` text, and lets a reverted buffer clear phantom errors on the next pull (GitHub #160).

`SidecarHost` processes IPC messages sequentially, awaiting each handler before reading the next frame, so `didChange` cannot arrive during a check. If dispatch becomes concurrent, checks MUST re-read buffer stability before publishing. The host-side `[DIAG-PUSH-GATE]` in [DIAGNOSTICS-SPEC.md](DIAGNOSTICS-SPEC.md) independently prevents stale results from being published.

## [HOVER-CACHING] Caching Strategy

Hover results MUST be memoized only through the [salsa](https://salsa-rs.github.io/salsa/) database in the Rust host. Sidecars and clients MUST NOT maintain hover-result caches.

| Salsa Query Input | Invalidation Trigger |
|---|---|
| `(document_uri, document_version, position, language)` | Document version change |
| Project generation | Any project or referenced-document change |

The Rust host SHOULD reuse the salsa result when all query inputs match. It MUST NOT maintain a separate most-recent-result slot or ad-hoc map. Stale hover requests for superseded document versions MUST be cancelled.

## [HOVER-PERFORMANCE] Performance Requirements

| Metric | Target | Measurement |
|---|---|---|
| Hover latency (p50) | <150ms | Time from hover trigger to tooltip render |
| Hover latency (p95) | <300ms | Time from hover trigger to tooltip render |
| Hover for cached position | <1ms | salsa cache hit |
| Tree-sitter pre-validation | <1ms | Whitespace/comment rejection |

## [HOVER-ERRORS] Error Handling

| Condition | Response |
|---|---|
| Position is whitespace or comment | Return `null` (no hover) |
| Sidecar not ready / loading | Return `null` with `window/showMessage` notification |
| Symbol resolution fails | Return `null` |
| XML documentation unavailable | Return signature without documentation section |
| Sidecar crashes during hover | Return `null`, trigger [SHARPLSP-ARCHITECTURE-SIDECARS](SHARPLSP-SPEC.md) recovery |

Hover MUST NOT block, hang, or return errors to the client. On any failure, return `null`.

## [HOVER-TREE] Solution Explorer Tree Hover

The Solution Explorer tree view MUST use the **same hover** as the code editor. When a user hovers over a symbol in the tree, the tooltip MUST be identical to the tooltip shown when hovering over the same symbol in the code editor.

### [HOVER-TREE-IMPLEMENTATION] Implementation

Tree item tooltips are resolved via `resolveTreeItem()`, which calls `vscode.executeHoverProvider` at the symbol's source position. This triggers the exact same `textDocument/hover` LSP request pipeline (Rust host -> sidecar -> Roslyn/FCS) used by the code editor.

| Tree Node Type | Tooltip Source |
|---|---|
| Symbol (class, method, property, etc.) | LSP hover (`textDocument/hover`) — same as code editor |
| Namespace | LSP hover (`textDocument/hover`) — same as code editor |
| NuGet Package | Static metadata (package name + version) |
| Project Reference | Static metadata (reference name) |
| Solution / Project / Folder | No tooltip |

Tree hover and code hover MUST produce identical content for the same symbol; any divergence is a bug.
