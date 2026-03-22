---
layout: layouts/docs.njk
title: Hover and Quick Info
eleventyNavigation:
  key: Hover and Quick Info
  order: 6
---

**VS Code**
![Hover in VS Code](/assets/screenshots/vscode-hover-page.png)

**Zed**
![Hover in Zed](/assets/screenshots/zed-hover-page.png)

*Hover shows full XML documentation, type signatures, and nullability annotations.*

# Hover and Quick Info

Hover over any symbol to see its full type signature, XML documentation, parameter descriptions, nullability annotations, and deprecation notices. Forge implements `textDocument/hover` (LSP 3.17) for both C# and F# as equal first-class citizens.

## What You See

When you hover a symbol, Forge returns a Markdown-rendered tooltip containing:

| Section | Content |
|---------|---------|
| **Signature** | Fully qualified symbol signature with syntax highlighting |
| **Containing type** | `ContainingType.Name` for members |
| **XML documentation** | `<summary>`, `<param>`, `<returns>`, `<remarks>`, `<example>` |
| **Exceptions** | `<exception>` tags from XML docs |
| **Nullability** | Nullable annotation state |
| **Accessibility** | `public`, `internal`, `protected`, etc. |
| **Deprecation** | `[Obsolete]` message with warning |

## C# Hover (Roslyn)

The C# sidecar resolves symbols via `SemanticModel.GetSymbolInfo()` and renders XML documentation from three sources in priority order:

1. Source code `///` comments
2. XML documentation files from NuGet packages (`.xml` files alongside assemblies)
3. Roslyn's built-in documentation provider

### Special Cases

| Hover Target | Behavior |
|--------------|---------|
| `var` keyword | Shows the inferred type with full signature |
| `await` expression | Shows the unwrapped `Task<T>` return type |
| `nameof(Foo)` | Shows the referenced symbol |
| String literals | Returns `null` (no tooltip) |
| Lambda parameters | Shows inferred parameter types |
| Tuple elements | Shows element names and types |
| Pattern variables | Shows the pattern-matched type |
| `[Obsolete]` members | Shows deprecation message |

### Example

```csharp
var result = Enumerable.Range(0, 10).Select(x => x * x).ToList();
//           ↑ hover shows:
// IEnumerable<int> Enumerable.Range(int start, int count)
// Generates a sequence of integral numbers within a specified range.
// Parameters:
//   start: The value of the first integer in the sequence.
//   count: The number of sequential integers to generate.
```

## F# Hover (FSharp.Compiler.Service)

The F# sidecar resolves symbols via `FSharpCheckFileResults.GetToolTip()` and renders the `ToolTipElement` structure into Markdown. XML documentation is rendered through the same shared `XmlDocRenderer` used by the C# sidecar.

### F#-Specific Cases

| Hover Target | Behavior |
|--------------|---------|
| Discriminated union cases | Shows case fields with types |
| Record fields | Shows field type and containing record |
| Pipeline operators (`\|>`, `>>`) | Shows inferred function types |
| Active patterns | Shows the pattern signature and documentation |
| Computation expression keywords (`let!`, `do!`, `return!`) | Shows the CE builder method |
| Type providers | Shows the provided type and its properties |
| Measure types | Shows the unit of measure annotation |

### Example

```fsharp
let result = [1..10] |> List.map (fun x -> x * x) |> List.sum
//                       ↑ hover shows:
// val map: mapping: ('T -> 'U) -> list: 'T list -> 'U list
// Builds a new collection whose elements are the results
// of applying the given function to each of the elements
// of the collection.
```

## Solution Explorer Hover

The Solution Explorer tree view uses the **same hover pipeline** as the code editor. When you hover a symbol in the tree, the tooltip is identical to the one shown in the code editor.

| Tree Node Type | Tooltip Source |
|---|---|
| Symbol (class, method, property, etc.) | LSP hover --- same as code editor |
| Namespace | LSP hover --- same as code editor |
| NuGet Package | Package name + version |
| Project Reference | Reference name |

## Caching

Hover results are cached by the Rust host via [salsa](https://salsa-rs.github.io/salsa/) incremental computation.

| Cache Key | Invalidated When |
|-----------|-----------------|
| `(document_uri, document_version, position)` | Document is edited |

A cache hit returns in under 1ms. Stale hover requests for superseded document versions are cancelled immediately.

## Performance Targets

| Metric | Target |
|--------|--------|
| Hover latency (p50) | <150ms |
| Hover latency (p95) | <300ms |
| Cached position | <1ms |
| Tree-sitter pre-validation (skip whitespace) | <1ms |

## Error Handling

Hover never returns errors or blocks the editor. On any failure — sidecar not ready, symbol resolution failure, IPC timeout — Forge returns `null` (no tooltip). Sidecar crashes trigger automatic recovery within 3 seconds.

## Competitive Comparison

| Feature | Visual Studio | C# Dev Kit | Rider | **Forge** |
|---------|:---:|:---:|:---:|:---:|
| Basic symbol hover | ✓ | ✓ | ✓ | ✓ |
| XML documentation | ✓ | ✓ | ✓ | ✓ |
| `var` inferred type | ✓ | ✓ | ✓ | ✓ |
| NuGet XML docs | ✓ | ✓ | ✓ | ✓ |
| Exception documentation | ✓ | ✗ | ✓ | ✓ |
| Nullable annotation display | ✓ | ✓ | ✓ | ✓ |
| Deprecation warnings | ✓ | ✓ | ✓ | ✓ |

