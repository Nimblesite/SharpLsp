---
layout: layouts/docs.njk
title: F# Language Support
eleventyExcludeFromCollections: true
---

# F# Language Support

F# is a **first-class citizen** in SharpLsp — not a bolt-on. The same Rust LSP host that drives C# routes F# requests to a long-running F# sidecar built on the [F# Compiler Service (FCS)](https://fsharp.github.io/fsharp-compiler-docs/), [Fantomas](https://fsprojects.github.io/fantomas/), and SharpLsp's own FCS-backed static analyzers.

The reference implementation for F# tooling is [FsAutoComplete (FSAC)](https://ionide.io/Tools/fsac.html) — the engine behind Ionide. SharpLsp targets **full FSAC feature parity, then beyond**, while staying **editor-agnostic**: one server, every editor, standard LSP wherever possible.

## Feature Parity at a Glance

| FSAC / Ionide feature | SharpLsp | Notes |
|---|---|---|
| Completion + resolve | ✅ | FCS `GetDeclarationListInfo`; unopened-namespace suggestions |
| Hover / tooltips | ✅ | Markdown signature + XML/docstring |
| Signature help | ✅ | Overload selection + per-parameter hints |
| Go to Definition | ✅ | Cross-file via FCS symbol uses |
| Type Definition | ✅ | |
| Implementation | ✅ | |
| Find References | ✅ **project-wide** | Exceeds FSAC's file-local default |
| Document Highlight | ✅ | |
| Rename | ✅ **project-wide** | Prepare + apply, multi-document edit |
| Document Symbols / Outline | ✅ | FCS navigation items, nested hierarchy |
| Workspace Symbols | ✅ | |
| Formatting (Fantomas) | ✅ | Whole-document + range |
| Code Actions / Quick Fixes | ✅ | See [the matrix below](#code-actions--quick-fixes) |
| Code Lens (reference count) | ✅ | Lens above every top-level definition |
| Inlay Hints | ✅ | Type, parameter-name, **and pipeline** hints |
| Folding Range | ✅ | tree-sitter, &lt;10 ms |
| Selection Range | ✅ | tree-sitter |
| Semantic Tokens | ✅ | FCS symbol classification, delta-encoded |
| Diagnostics | ✅ | FCS compiler errors + analyzers |
| Unused-code analysis | ✅ **project-wide** | Dead-code analyzer; monorepo mode |
| Call Hierarchy | ✅ | Incoming + outgoing (beyond FSAC) |
| Type Hierarchy | ✅ | Supertypes + subtypes (beyond FSAC) |
| F# Interactive (FSI) | ✅ | Send selection / file, generate signature |

Legend: ✅ supported today. Roadmap items are listed under [What's Next](#whats-next).

## IntelliSense

### Completion

Completions come from FCS `GetDeclarationListInfo` at the cursor. The list includes keywords and members from opened namespaces, plus **symbols from unopened namespaces** — the completion detail shows the `open` that would be required, matching FSAC's external-autocomplete behaviour.

### Hover & Signature Help

Hover renders a Markdown tooltip with the symbol's signature and documentation. Signature help resolves overloads through FCS `GetMethods`, highlights the active parameter, and updates as you type arguments.

### Inlay Hints

SharpLsp renders three hint kinds, configurable in [`sharplsp.toml`](/docs/configuration/):

| Hint | Example |
|---|---|
| **Type** hints on `let` bindings | `let x` `: int` |
| **Parameter-name** hints at call sites | `add (`x =`1) (`y =`2)` |
| **Pipeline** type hints after `\|>` | the inferred type flowing through a pipeline |

Pipeline hints are a SharpLsp extension beyond the FSAC hint set.

## Navigation

Go-to-definition, type-definition, and implementation resolve through FCS symbol uses and navigate across files in the loaded project.

**Find References, Rename, Document Highlight, Call Hierarchy, and Type Hierarchy are project-wide.** Where FSAC resolves references in the current file by default, SharpLsp uses `ParseAndCheckProject` + `GetUsesOfSymbol` so every occurrence across the project is found, renamed, or highlighted in a single operation.

## Code Actions & Quick Fixes

The F# sidecar maps FCS compiler diagnostics to actionable fixes:

| Trigger | Quick Fix |
|---|---|
| `FS0039` undefined name | Suggest `open` for the resolving namespace |
| `FS0001` type mismatch | Insert the obvious conversion |
| `FS0020` implicitly ignored value | `ignore` the value |
| `FS0025` incomplete match | Generate the missing match cases |
| `FS0026` redundant case | Remove the dead pattern |
| `FS1182` unused value | Replace with `_` |
| Union value | **Generate union-case match arms** |
| Record value | **Generate missing record-field stubs** |

These cover FSAC's "generate union pattern cases", "replace unused with `_`", "resolve namespace", "fix typo", and stub-generation fixes.

## Diagnostics & Analyzers

Diagnostics are dual-sourced: FCS compiler errors plus SharpLsp's own analyzers, merged into a single `workspace/diagnostics` response.

| Analyzer | Code | FSAC / Ionide | SharpLsp |
|---|---|---|---|
| Unused `open` detection | `SLSPF0102` | ✅ | ✅ Hint, removable |
| Simplify name / redundant qualifier | `SLSPF0103` | ✅ | ✅ Hint |
| Unused-symbol / dead-code | `SLSPF0101` | ✅ file-local | ✅ **project-wide** |

- **Project-wide dead-code analysis** (`SLSPF0101`) walks every symbol use in the project (`GetAllUsesOfAllSymbols`), so a declaration with no non-definition reference anywhere is flagged — not just within the open file. Private/internal dead code is reported as a **warning** even in ordinary repos, because it can never be reached from outside the assembly.
- **Monorepo mode** (`[analyzers] monorepo = true` in `sharplsp.toml`) treats the repository as the entire world: an unused *public* symbol is then genuinely dead and is escalated from a warning to a hard **error**. No FSAC/Ionide rule offers a cross-project deadness gate — this is unique to SharpLsp.
- The unused-`open` (`SLSPF0102`) and simplify-name (`SLSPF0103`) analyzers run via FCS `EditorServices` (`UnusedOpens`, `SimplifyNames`) as always-on `Hint` diagnostics, matching FSAC's "remove unused open" and "simplify name".

The host reads the `[analyzers]` table and pushes the flags to the sidecar via `analyzers/configure` right after the workspace loads. See [Diagnostics](/docs/diagnostics/) for the full pipeline and [`DIAGNOSTICS-STATIC-ANALYZERS-SPEC`](https://github.com/Nimblesite/SharpLsp/blob/main/docs/specs/DIAGNOSTICS-STATIC-ANALYZERS-SPEC.md) for the design.

## Formatting (Fantomas)

Document and range formatting are powered by [Fantomas.Core](https://fsprojects.github.io/fantomas/), the same formatter FSAC uses, so output matches the `.editorconfig`/`fantomas-tool` conventions your team already follows.

## F# Interactive (FSI)

The VS Code extension drives a terminal-backed F# Interactive session:

| Command | Action |
|---|---|
| `SharpLsp: Send Selection to FSI` | Evaluate the selected expression |
| `SharpLsp: Send File to FSI` | Load the whole file |
| `SharpLsp: Start FSI` | Open an interactive session |
| `SharpLsp: Generate Signature` | Produce an `.fsi` signature from the implementation |

FSI launches through the **same .NET 10 SDK SharpLsp acquired on activation** (see [Getting Started](/docs/)), so it works even when `dotnet` is not on your `$PATH` — exactly the case right after the extension installs the SDK for you. Pass custom flags to `dotnet fsi` (Ionide's `fsiExtraParameters` equivalent) with `sharplsp.fsi.extraArgs` in [`sharplsp.toml`](/docs/configuration/) or your editor settings; the setting is honoured only in trusted workspaces.

## Editor-Agnostic by Design

Ionide exposes F#-specific protocol extensions (`fsharp/signature`, `fsharp/workspacePeek`, `fsharp/f1Help`, …) that only Ionide-aware editors understand. SharpLsp prefers **standard LSP** so every editor — VS Code, Neovim, Helix, Emacs, Zed — gets the same experience without custom client code:

| Ionide custom endpoint | SharpLsp standard-LSP equivalent |
|---|---|
| `fsharp/signature`, `fsharp/signatureData` | `textDocument/hover`, `textDocument/signatureHelp` |
| `fsharp/lineLens` | `textDocument/codeLens` |
| `fsharp/workspaceLoad`, `fsharp/project` | Automatic solution/project loading on activation |
| `fsharp/documentation`, `fsharp/documentationSymbol` | Hover Markdown documentation |

## What's Next

Tracked in [`docs/plans/FSHARP-FEATURES-PLAN.md`](https://github.com/Nimblesite/SharpLsp/blob/main/docs/plans/FSHARP-FEATURES-PLAN.md):

- **Unsaved-buffer fidelity** — stream `didChange` to the F# sidecar so results reflect in-flight edits, not just on-disk content.
- **Completion auto-`open` insertion** — apply the namespace `open` as an additional text edit on accept.
- **Multi-project workspaces** — load every `.fsproj` in a solution, not just the first.
- **FSDN / F1 help** — signature search and documentation lookup.
- **Cross-language hierarchy** — F# ↔ C# call/type edges via a unified symbol index.

<p class="next-link"><a href="/docs/diagnostics/">Next: Diagnostics <span class="material-symbols-outlined" aria-hidden="true">arrow_forward</span></a></p>
