---
layout: layouts/docs.njk
title: Go to Definition
eleventyExcludeFromCollections: true
---

![Go to Definition in VS Code](/assets/screenshots/vscode-go-to-definition-page.png)

*C# definition navigation in the alpha VS Code extension.*

# Go to Definition

Forge is building the LSP definition navigation family on top of the Roslyn sidecar. The current extension exposes the VS Code workflow while edge cases continue to be hardened.

## Navigation Methods

| LSP Method | Shortcut (VS Code) | Description |
|------------|-------------------|-------------|
| `textDocument/definition` | `F12` | Navigate to the symbol's declaration |
| `textDocument/typeDefinition` | `Ctrl+F12` | Navigate to the type of the symbol |
| `textDocument/declaration` | — | Navigate to the interface / abstract declaration |
| `textDocument/implementation` | `Ctrl+Shift+F12` | Navigate to all concrete implementations |

The navigation family is a launch-blocking area for Forge. In the alpha, validate the specific operation and project shape you depend on.

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
