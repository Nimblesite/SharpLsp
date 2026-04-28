---
layout: layouts/docs.njk
title: Code Completions
eleventyNavigation:
  key: Code Completions
  order: 4
---

![Code completions in VS Code](/assets/screenshots/vscode-completions-page.png)

*C# completions powered by Roslyn in the alpha VS Code extension.*

# Code Completions

Forge provides C# code completions through Roslyn. Completions are routed through the C# sidecar, keeping the Rust host free for fast syntax operations.

## Performance Targets

| Metric | Target |
|--------|--------|
| p50 latency | <100ms |
| p95 latency | <200ms |
| Cached (unchanged document) | <1ms |

## C# Completions (Roslyn)

The C# sidecar uses Roslyn's `CompletionService` to generate completions, so the feature is built on the same compiler platform used by the wider .NET tooling ecosystem.

### What Gets Completed

- **Types and namespaces** — classes, interfaces, structs, enums, delegates
- **Members** — methods, properties, fields, events, indexers
- **Keywords** — all C# keywords with correct contextual filtering
- **Snippets** — common code patterns (`for`, `foreach`, `if`, `try`, etc.)
- **Import completions** — unimported types from referenced assemblies
- **Override completions** — abstract/virtual members to implement
- **XML doc completions** — `///` trigger completes `<summary>`, `<param>`, etc.
- **`var` inference** — shows the inferred type in the completion tooltip

### Trigger Characters

Completions trigger automatically after:

| Character | Context |
|-----------|---------|
| `.` | Member access |
| `(` | Parameter hints |
| `<` | Generic type arguments |
| `[` | Array indexer, attribute |
| `{` | Object initializer |
| ` ` | Keyword completions |
| `@` | Verbatim identifiers |

### Import Completions

Types that are not yet `using`-imported appear in the completion list with a dimmed indicator. Selecting one automatically adds the correct `using` directive at the top of the file.

```csharp
// Before: no using for JsonSerializer
var json = JsonSerializer.Serialize(obj);
//         ↑ completion adds: using System.Text.Json;
```

## LSP Protocol

Forge advertises:

```json
{
  "completionProvider": {
    "resolveProvider": true,
    "triggerCharacters": [".", "(", "<", "[", "{", " ", "@"]
  }
}
```

`completionItem/resolve` is supported — full documentation and additional edits (e.g., import insertion) are added on resolve, keeping the initial list fast.
