# Hover / Quick Info Specification

**Parent:** [SHARPLSP-SPEC.md](SHARPLSP-SPEC.md)

## 1. Overview

Hover (Quick Info) provides rich tooltip information when the user hovers over a symbol or keyword. SharpLsp implements `textDocument/hover` ([LSP 3.17 §3.17.5](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_hover)) for both C# and F# as equal first-class citizens.

This feature is **P0** (launch blocker) and targets Phase 2 delivery.

## 2. LSP Protocol

### 2.1 Request

```
method: textDocument/hover
params: HoverParams {
    textDocument: TextDocumentIdentifier
    position: Position
}
```

### 2.2 Response

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

## 3. Request Routing

Hover is a **semantic** request. The Rust host routes it to the appropriate sidecar based on document language.

| Step | Component | Action |
|---|---|---|
| 1 | Rust host | Receives `textDocument/hover`, identifies language from VFS |
| 2 | Rust host | Dispatches to C# sidecar (Roslyn) or F# sidecar (FCS) via IPC |
| 3 | Sidecar | Resolves symbol at position, builds Markdown response |
| 4 | Rust host | Returns `Hover` result to client |

The Rust host MAY use tree-sitter to pre-validate the hovered position (e.g., skip hover for whitespace/comments) and short-circuit with `null` before dispatching to the sidecar.

## 4. C# Implementation (Roslyn)

### 4.1 Symbol Resolution

1. Obtain `Document` from the current `Solution` snapshot for the given URI.
2. Get `SemanticModel` via [`Document.GetSemanticModelAsync()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.document.getsemanticmodelasync).
3. Find the syntax token at position via [`SyntaxTree.GetRoot().FindToken()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.syntaxtree).
4. Resolve symbol via [`SemanticModel.GetSymbolInfo()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.semanticmodel.getsymbolinfo) on the token's parent node.
5. If `GetSymbolInfo()` returns no symbol, fall back to [`SemanticModel.GetTypeInfo()`](https://learn.microsoft.com/en-us/dotnet/api/microsoft.codeanalysis.semanticmodel.gettypeinfo) for implicit types and expressions.
6. For keywords (`var`, `await`, `async`, `nameof`, etc.), provide keyword-specific documentation.

### 4.2 Markdown Rendering

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

#### XML Documentation Rendering

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

### 4.3 Special Cases

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

## 5. F# Implementation (FCS)

### 5.1 Symbol Resolution

1. Get `FSharpCheckFileResults` for the document via `FSharpChecker.CheckFileInProject()`.
2. Call `GetToolTip(line, col, lineText, names, tokenTag)` to obtain `ToolTipText`.
3. `ToolTipText` contains `ToolTipElement[]`, each with a structured layout and XML documentation.

### 5.2 Markdown Rendering

F# hover follows the same Markdown structure as C#:

| Section | Content | Source |
|---|---|---|
| Signature | F# type signature | `ToolTipElement.MainDescription` |
| Documentation | XML doc summary | `ToolTipElement.XmlDoc` |
| Full name | Fully qualified name | `ToolTipElement.Remarks` |
| Constraints | Generic constraints | Extracted from signature |
| Union cases | Case fields and types | `ToolTipElement` for DU cases |

### 5.3 F#-Specific Cases

| Hover Target | Behavior |
|---|---|
| Computation expression keywords (`let!`, `do!`, `return!`) | Show the CE builder method |
| Pipeline operators (`\|>`, `>>`) | Show inferred function types |
| Active patterns | Show the pattern signature and documentation |
| Type providers | Show the provided type and its properties |
| Measure types | Show the unit of measure annotation |
| Discriminated union cases | Show case fields with types |
| Record fields | Show field type and containing record |

### 5.4 Live-Buffer Resolution `[FS-DIDCHANGE-OVERLAY]`

Hover MUST resolve against the editor's **in-memory buffer**, not the on-disk
file. The Rust host forwards `textDocument/didOpen`/`didChange` to the document's
own sidecar (F# → F# sidecar, C# → C# sidecar); routing by language is mandatory,
since a misrouted edit leaves the owning sidecar resolving positions against stale
text. The F# sidecar keeps an in-memory overlay keyed by absolute file path and
every per-file analysis (hover, completion, signature help, …) reads source via
that overlay, falling back to disk only when no open buffer exists. This restores
F# to parity with C#, whose Roslyn workspace is already updated in place on
`didChange`. Without this, F# hover misaligns the moment the buffer diverges from
disk (i.e. as soon as the user types) and returns the wrong symbol or `null`.

### 5.5 Canonical Check Funnel `[FS-DIDCHANGE-OVERLAY]`

Every per-file FCS analysis (hover, completion, diagnostics, signature help,
inlay hints, code fixes, file ordering) funnels through **one** canonical
check — `parseAndCheckOnce` (the raw parse+check) and its `checkFileWithParse`
/ `checkFile` views — rather than each call site invoking
`FSharpChecker.ParseAndCheckFileInProject` itself. This keeps overlay-aware
source resolution and `FSharpCheckFileAnswer` handling in exactly one place
(DRY) and guarantees every feature type-checks the **live didChange buffer**,
so a reverted or freshly edited file is always analysed as its newest text
instead of stale on-disk content — the property that lets a reverted buffer
clear its phantom errors on the next pull (GitHub #160).

The sidecar processes IPC messages strictly sequentially — `SidecarHost`
awaits each handler to completion before reading the next frame — so a
`didChange` never lands while a check is in flight; the source a check reads is
always the newest committed buffer. (Should dispatch ever become concurrent, a
mid-check stability re-read would be needed here; it is deliberately omitted
today because that path is unreachable and cannot be exercised by a
deterministic test.) This is the sidecar-side complement of the Rust host's
push gate `[DIAG-PUSH-GATE]` (DIAGNOSTICS-SPEC §1.3), which guarantees stale
results are never *published*.

## 6. Caching Strategy

Hover results are cached via the [salsa](https://salsa-rs.github.io/salsa/) incremental computation database in the Rust host.

| Cache Key | Invalidation Trigger |
|---|---|
| `(document_uri, document_version, position)` | Document edit (version change) |
| Semantic model snapshot | Any document change in the project |

The Rust host SHOULD cache the most recent hover result per document and return it immediately if the position and version match. Stale hover requests for superseded document versions MUST be cancelled.

## 7. Performance Requirements

| Metric | Target | Measurement |
|---|---|---|
| Hover latency (p50) | <150ms | Time from hover trigger to tooltip render |
| Hover latency (p95) | <300ms | Time from hover trigger to tooltip render |
| Hover for cached position | <1ms | salsa cache hit |
| Tree-sitter pre-validation | <1ms | Whitespace/comment rejection |

## 8. Error Handling

| Condition | Response |
|---|---|
| Position is whitespace or comment | Return `null` (no hover) |
| Sidecar not ready / loading | Return `null` with `window/showMessage` notification |
| Symbol resolution fails | Return `null` |
| XML documentation unavailable | Return signature without documentation section |
| Sidecar crashes during hover | Return `null`, trigger crash recovery (see SHARPLSP-SPEC §5) |

Hover MUST NOT block, hang, or return errors to the client. On any failure, return `null`.

## 9. Solution Explorer Tree Hover

The Solution Explorer tree view MUST use the **same hover** as the code editor. When a user hovers over a symbol in the tree, the tooltip MUST be identical to the tooltip shown when hovering over the same symbol in the code editor.

### Implementation

Tree item tooltips are resolved via `resolveTreeItem()`, which calls `vscode.executeHoverProvider` at the symbol's source position. This triggers the exact same `textDocument/hover` LSP request pipeline (Rust host -> sidecar -> Roslyn/FCS) used by the code editor.

| Tree Node Type | Tooltip Source |
|---|---|
| Symbol (class, method, property, etc.) | LSP hover (`textDocument/hover`) — same as code editor |
| Namespace | LSP hover (`textDocument/hover`) — same as code editor |
| NuGet Package | Static metadata (package name + version) |
| Project Reference | Static metadata (reference name) |
| Solution / Project / Folder | No tooltip |

**Critical invariant:** Tree hover and code hover MUST produce identical content for the same symbol. They are the same code path. Any divergence is a bug.

## 10. Competitive Parity Matrix

| Feature | VS | CDK | Rider | SharpLsp Target | Priority |
|---|---|---|---|---|---|
| Basic symbol hover | ✓ | ✓ | ✓ | ✓ | P0 |
| XML doc rendering | ✓ | ✓ | ✓ | ✓ | P0 |
| Inferred type hover (`var`) | ✓ | ✓ | ✓ | ✓ | P0 |
| Exception documentation | ✓ | ✗ | ✓ | ✓ | P1 |
| Nullable annotation display | ✓ | ✓ | ✓ | ✓ | P1 |
| Deprecation warnings | ✓ | ✓ | ✓ | ✓ | P0 |
| NuGet package XML docs | ✓ | ✓ | ✓ | ✓ | P0 |
| Color preview in hover | ✓ | ✗ | ✓ | ✓ | P2 |
| Quick navigation from hover | ✓ | ✗ | ✓ | ✓ | P2 |
