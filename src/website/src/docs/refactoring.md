---
layout: layouts/docs.njk
title: Refactoring & Code Actions
eleventyNavigation:
  key: Refactoring & Code Actions
  order: 7
---

![Code actions lightbulb in VS Code](/assets/screenshots/vscode-refactoring.png)

# Refactoring and Code Actions

SharpLsp supports standard LSP code actions for C# and F#. Actions are context-dependent: the sidecar returns only fixes or refactorings whose compiler/provider can operate on the current diagnostic, cursor, or selection.

In VS Code, use the lightbulb or **Quick Fix** command (`Ctrl+.` on Windows/Linux, `Cmd+.` on macOS).

## C# Actions

The C# sidecar discovers Roslyn code-fix and refactoring providers from the bundled Roslyn feature assemblies. It asks providers for actions at the requested range and resolves the selected action into a workspace edit.

Verified examples include:

- add a missing import;
- remove an unused local;
- generate a missing method;
- Roslyn refactorings offered for a valid type or selection.

The exact list varies with syntax, diagnostics, Roslyn version, and available providers. A blank line or unsupported location correctly returns no actions; the presence of a category does not mean every Visual Studio refactoring is available.

## F# Actions

The F# sidecar provides a defined set of compiler-driven and generated actions:

| Trigger or context | Action |
|---|---|
| `FS0039` | Add a resolving `open` when a namespace can be identified |
| `FS1182` | Prefix an unused binding with `_` |
| `FS0020` | Add `|> ignore` |
| `FS0025` | Add a wildcard match arm |
| `FS0026` | Remove a redundant pattern |
| supported `FS0001` mismatches | Insert a known conversion |
| discriminated-union match | Generate missing cases |
| record expression | Generate missing fields |
| interface implementation | Generate member stubs |
| `SLSPF0102` / `SLSPF0103` | Remove an unused `open` / simplify a name |

Compiler typo fixes and some FSAC actions remain unimplemented; see [F# Language Support](/docs/fsharp/).

## Resolve and Apply

`textDocument/codeAction` returns lightweight items. `codeAction/resolve` computes the edits only for the selected action. Resolved workspace edits can change multiple existing documents.

If an action has expired, the sidecar restarted, or the provider cannot produce an apply operation, resolve returns no edit instead of guessing.

## Rename Is Separate

Rename is not a code action. SharpLsp advertises `textDocument/prepareRename` and `textDocument/rename`:

- C# rename uses the loaded Roslyn solution.
- F# rename uses the loaded F# project and can edit multiple files.

Use your editor's **Rename Symbol** command.

## Formatting and Sort Members

SharpLsp intentionally does not advertise LSP formatting. Use CSharpier or Fantomas for formatting. The VS Code **Sort Members** command is a separate C# tree-sitter operation with configurable accessibility, category, and alphabetical ordering.
