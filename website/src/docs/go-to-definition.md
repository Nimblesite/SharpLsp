---
layout: layouts/docs.njk
title: Go to Definition
eleventyNavigation:
  key: Go to Definition
  order: 7
---

**VS Code**
![Go to Definition in VS Code](/assets/screenshots/vscode-go-to-definition-page.png)

**Zed**
![Go to Definition in Zed](/assets/screenshots/zed-go-to-definition-page.png)

*Navigate to any symbol definition, type definition, declaration, or implementation — all four LSP navigation methods fully implemented.*

# Go to Definition

Forge implements the full family of definition navigation requests from LSP 3.17, covering every C# navigation scenario via the Roslyn sidecar.

## Navigation Methods

| LSP Method | Shortcut (VS Code) | Description |
|------------|-------------------|-------------|
| `textDocument/definition` | `F12` | Navigate to the symbol's declaration |
| `textDocument/typeDefinition` | `Ctrl+F12` | Navigate to the type of the symbol |
| `textDocument/declaration` | — | Navigate to the interface / abstract declaration |
| `textDocument/implementation` | `Ctrl+Shift+F12` | Navigate to all concrete implementations |

All four are **P0** (launch blockers) and fully implemented for C#.

## C# Navigation (Roslyn)

### textDocument/definition

Roslyn resolves the symbol via `SemanticModel.GetSymbolInfo()` and returns source locations from `ISymbol.Locations`.

### textDocument/implementation

Uses `SymbolFinder.FindImplementationsAsync()` to locate all concrete implementations across the solution. Returns `Location[]` when multiple exist (e.g., interface with ten implementing classes).

### Special Cases

| Symbol | `definition` | `typeDefinition` | `declaration` | `implementation` |
|--------|-------------|-----------------|---------------|-----------------|
| Variable (`var x = new Foo()`) | Variable declaration | `Foo` class | Same as definition | — |
| Method call (`bar.Baz()`) | Method body | Return type | Interface / abstract method | All overrides |
| Interface member | Interface declaration | Member return type | Same | All implementing classes |
| Override method | Override site | Return type | Base virtual/abstract | All sibling overrides |
| Constructor (`new Foo()`) | Constructor declaration | `Foo` class | Same | — |
| Partial class / method | First `partial` declaration | The type | Defining partial | All partial parts |

### Decompiled Source Navigation

When a symbol is defined in a referenced assembly (NuGet package, BCL), Forge uses [ICSharpCode.Decompiler](https://github.com/icsharpcode/ILSpy) to decompile the containing type on demand. The decompiled source opens in a read-only buffer, giving you full navigation even into framework internals.

```csharp
// Ctrl+click on List<T>.Add() navigates to decompiled:
// public void Add(T item) {
//     if (_size == _items.Length) EnsureCapacity(_size + 1);
//     _items[_size++] = item;
//     _version++;
// }
```

## Caching

All definition results are cached via salsa with the key `(document_uri, version, position, method)`. Cache hits return in under 1ms. The `method` component distinguishes between `definition`, `typeDefinition`, `declaration`, and `implementation` for the same position.

## Performance Targets

| Metric | Target |
|--------|--------|
| Definition latency (p50) | <100ms |
| Definition latency (p95) | <250ms |
| Cached definition | <1ms |
| Find implementations (100 impls) | <500ms |

## Competitive Comparison

| Feature | Visual Studio | C# Dev Kit | Rider | **Forge** |
|---------|:---:|:---:|:---:|:---:|
| Go to definition (source) | ✓ | ✓ | ✓ | ✓ |
| Go to definition (metadata) | ✓ | ✓ | ✓ | ✓ |
| Go to type definition | ✓ | ✓ | ✓ | ✓ |
| Go to declaration | ✓ | ✓ | ✓ | ✓ |
| Go to implementation | ✓ | ✓ | ✓ | ✓ |
| Partial class navigation | ✓ | ✓ | ✓ | ✓ |
| Decompiled source | ✓ | ✓ | ✓ | ✓ |
| Peek definition | ✓ | ✓ | ✓ | ✓ |

