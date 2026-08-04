---
layout: layouts/docs.njk
title: F# Language Support
eleventyExcludeFromCollections: true
---

# F# Language Support

F# is a **first-class citizen** in SharpLsp. The Rust LSP host routes F# semantic requests to a long-running .NET 10 sidecar built on the [F# Compiler Service (FCS)](https://fsharp.github.io/fsharp-compiler-docs/). SharpLsp also contains Fantomas integration and its own FCS-backed analyzers, but only features routed and advertised by the host are described as available below.

[FsAutoComplete (FSAC)](https://ionide.io/Tools/fsac.html), the engine behind Ionide, is the parity target. SharpLsp has a broad working surface today, but it does **not** yet claim full FSAC parity.

## Feature Status

| Feature | Status | Current behavior |
|---|---|---|
| Completion | Partial | Members and in-scope symbols work; unopened-namespace suggestions and auto-`open` insertion are pending |
| Hover | Supported | FCS signature and XML documentation from the live buffer |
| Signature help | Supported | Overloads and active-parameter selection |
| Definition, type definition, declaration | Supported | Source and metadata navigation |
| Implementation | Partial | Currently falls back to the selected symbol's declaration rather than finding implementations or overrides |
| Find references | Supported | Project-wide within the loaded F# project |
| Document highlight | Supported | References in the current document |
| Rename | Supported | Prepare + project-wide multi-document edit |
| Document symbols / outline | Supported | FCS navigation items with nesting |
| Workspace symbols | Supported | F# documents are queried through FCS |
| Code actions / quick fixes | Supported | Compiler-driven and generated actions listed below |
| Code Lens | Supported | Reference counts for top-level definitions |
| Inlay Hints | Supported | Type, parameter-name, and Pipeline type hints |
| Semantic Tokens | Supported | Full, range, and delta responses |
| Diagnostics | Supported | FCS compiler diagnostics plus SharpLsp analyzers |
| Call Hierarchy | Supported | Incoming and outgoing calls |
| Type Hierarchy | Partial | Sidecar and host handlers exist; client capability advertisement is still pending |
| Formatting (Fantomas) | Not exposed | Implemented in the sidecar but intentionally not advertised or routed by the host |
| Folding / Selection Range | Not yet | The Rust host does not yet include an F# tree-sitter grammar |
| F# Interactive | Supported | VS Code commands for sending code, starting FSI, and generating signatures |

## IntelliSense

### Completion

FCS `GetDeclarationListInfo` supplies completion candidates. Member completion after `.` and symbols already in scope work today. SharpLsp does not yet provide FSAC's external-autocomplete entity index, so it cannot offer every symbol from an unopened namespace or add the corresponding `open` on resolve.

### Hover and Signature Help

Hover renders F# signatures and documentation as Markdown. Signature help uses FCS method-group information to show overloads and the active parameter. Both operate on unsaved editor content because `didOpen` and `didChange` text is synchronized to the F# sidecar.

### Inlay Hints

SharpLsp provides:

- inferred type hints for bindings;
- parameter-name hints at call sites;
- pipeline type hints for values flowing through `|>`.

The VS Code settings `sharplsp.inlayHints.typeInference`, `sharplsp.inlayHints.parameterNames`, and `sharplsp.inlayHints.pipelineTypes` are exposed but are not yet applied by the production extension. All generated hint categories may therefore appear regardless of those values.

## Navigation and Rename

Definition, type definition, declaration, references, highlight, and rename resolve through FCS symbol uses. References and rename scan the loaded F# project and can return edits in multiple files. The implementation handler is currently only a declaration fallback; it does not yet search for concrete implementations or overrides. Metadata symbols from the BCL or NuGet packages can open generated read-only decompiled source.

Cross-language hierarchy edges and multi-project F# workspace state are still incomplete.

## Code Actions and Quick Fixes

The F# sidecar currently exposes these actions when their context is valid:

| Trigger or context | Action |
|---|---|
| `FS0039` unresolved name | Add a resolving `open` declaration when FCS supplies a namespace |
| `FS1182` unused value | Prefix the binding with `_` |
| `FS0020` ignored result | Add `|> ignore` |
| `FS0025` incomplete match | Add a wildcard arm |
| `FS0026` redundant case | Remove the redundant pattern |
| `FS0001` supported type mismatch | Insert a known conversion |
| Discriminated-union match | Generate missing union cases |
| Record expression | Generate missing record fields |
| Interface implementation | Generate member stubs |
| `SLSPF0102` | Remove an unused `open` |
| `SLSPF0103` | Simplify a redundant qualified name |

Compiler typo suggestions and the FSAC “add `new`” fix are not implemented yet.

## Diagnostics and Analyzers

FCS compiler diagnostics are combined with SharpLsp's analyzers:

| Analyzer | Code | Scope |
|---|---|---|
| Unused symbol / dead code | `SLSPF0101` | Project-wide |
| Unused `open` | `SLSPF0102` | Current file |
| Redundant qualifier | `SLSPF0103` | Current file |

`[analyzers] dead_code = true` enables dead-code analysis. With `monorepo = false`, unreachable private/internal symbols are warnings and public symbols are treated as possible external API. With `monorepo = true`, unused public symbols are also reported and escalated to errors.

FSharpLint is present as a dependency but is not wired into the diagnostic pipeline yet.

## Formatting

SharpLsp does not advertise LSP formatting. The F# sidecar contains Fantomas document and range-formatting code, but the host intentionally sequesters it. Use a dedicated Fantomas integration for formatting until routing is enabled.

## F# Interactive

The VS Code extension provides:

| Command | Action |
|---|---|
| `F# Interactive: Send Selection` | Evaluate the current selection |
| `F# Interactive: Load File` | Send the active file |
| `F# Interactive: Start New Session` | Start or focus the terminal-backed session |
| `F#: Generate Signature File (.fsi)` | Generate an `.fsi` signature |

FSI uses the .NET 10 SDK located or installed during extension activation. Extra arguments come from the trusted-workspace VS Code setting `sharplsp.fsi.extraArgs`; they are not read from `sharplsp.toml`.

## Editor-Agnostic Protocol

SharpLsp prefers standard LSP methods for completion, hover, navigation, symbols, diagnostics, code lens, and hierarchies. VS Code is the supported client today; other editor integrations are still being prepared.

## Current Parity Gaps

The main remaining F# gaps are:

- unopened-namespace completion and auto-`open`;
- host-routed Fantomas formatting;
- F# folding and selection ranges;
- FSharpLint diagnostics;
- full `.fsx` semantic parity and FSAC documentation endpoints;
- multi-project F# workspaces and cross-language hierarchies;
- standard client advertisement for type hierarchy.

<p class="next-link"><a href="/docs/diagnostics/">Next: Diagnostics <span aria-hidden="true">→</span></a></p>
