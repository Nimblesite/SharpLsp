---
layout: layouts/docs.njk
title: Code Completions
description: "C# and F# code completion in SharpLsp: Roslyn for C#, the F# Compiler Service for F#, with replacement edits and import completions that add a missing using or open."
eleventyNavigation:
  key: Code Completions
  order: 4
---

<img src="/assets/screenshots/docs/completions.webp" alt="F# completion in Checkout.fs: basket |> List.min with min and minBy offered by the F# Compiler Service" width="2400" height="1500">

# Code Completions

SharpLsp provides semantic completion for both C# and F#. The Rust host routes each request to Roslyn or the F# Compiler Service (FCS), then returns standard LSP completion items with replacement ranges.

{% video "code-completions" %}

## C# Completion

C# completion uses Roslyn's `CompletionService`. It covers the symbols and keywords Roslyn makes available at the cursor, including members, types, namespaces, locals, parameters, and contextual keywords.

Each item includes a text edit, so accepting a completion replaces the current identifier instead of appending to it. `completionItem/resolve` asks Roslyn for the final change and returns any additional edits. For an import completion, those edits can add the required `using` directive.

## F# Completion

F# completion uses FCS `GetDeclarationListInfo`, including candidates from unopened namespaces. Accepting an import completion adds the required `open` and replaces the current token. The item names its namespace so you can distinguish types with the same name.

## Triggering Completion

SharpLsp advertises `.` as its automatic trigger character for member access in both languages. Editors can also request completion explicitly, such as with `Ctrl+Space` in VS Code.

Characters such as `(` and `,` belong to signature help, not completion, and are advertised separately.

## LSP Capability

```json
{
  "completionProvider": {
    "resolveProvider": true,
    "triggerCharacters": ["."]
  }
}
```

Completion results are computed from the current unsaved buffer. If the relevant language sidecar is disabled or unavailable, SharpLsp returns no semantic items rather than fabricating results.
