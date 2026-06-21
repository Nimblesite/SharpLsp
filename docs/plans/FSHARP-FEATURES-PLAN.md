# F# Features Plan — C# Feature Parity

F# is a **first-class citizen**. This plan tracks closing the gap between what the
F# sidecar (FCS) handles and what the C# sidecar (Roslyn) handles, so that every
LSP capability routed by the Rust host works identically for `.fs` and `.cs`/`.cms`.

## How requests reach a sidecar

The Rust host ([src/main.rs](../../src/main.rs)) routes each LSP method to **one**
sidecar chosen purely by document language ([src/main.rs:763](../../src/main.rs#L763)
`pick_sidecar`): `.fs` → F# sidecar, everything else → C# sidecar. The wire
contract for every method is fixed by the Rust handler's MessagePack request/response
structs (positional, `[Key(n)]`-ordered). A sidecar reaches parity for a method by
registering that method name and returning a wire-compatible payload. If the F#
sidecar does **not** register a routed method, `.fs` files silently get nothing for
that feature — that is the parity gap.

## Parity matrix (routed LSP methods)

| LSP method | Rust handler | C# (Roslyn) | F# (FCS) | Spec |
|---|---|---|---|---|
| `textDocument/completion` | [semantic.rs:24](../../src/semantic.rs#L24) | ✅ | ✅ **(this plan)** | [FS-COMPLETION] |
| `completionItem/resolve` | [semantic.rs:87](../../src/semantic.rs#L87) | ✅ | ✅ **(this plan)** | [FS-COMPLETION-RESOLVE] |
| `textDocument/prepareRename` | [semantic.rs:920](../../src/semantic.rs#L920) | ✅ | ✅ **(this plan)** | [FS-RENAME-PREPARE] |
| `textDocument/rename` | [semantic.rs:965](../../src/semantic.rs#L965) | ✅ | ✅ **(this plan)** | [FS-RENAME-APPLY] |
| `textDocument/codeLens` | [code_lens.rs:15](../../src/code_lens.rs#L15) | ✅ | ✅ **(this plan)** | [FS-CODELENS] |
| `textDocument/prepareCallHierarchy` | [call_hierarchy.rs:19](../../src/call_hierarchy.rs#L19) | ✅ | ✅ **(this plan)** | [FS-CALLHIER-PREPARE] |
| `callHierarchy/incomingCalls` | [call_hierarchy.rs:59](../../src/call_hierarchy.rs#L59) | ✅ | ✅ **(this plan)** | [FS-CALLHIER-INCOMING] |
| `callHierarchy/outgoingCalls` | [call_hierarchy.rs:108](../../src/call_hierarchy.rs#L108) | ✅ | ✅ **(this plan)** | [FS-CALLHIER-OUTGOING] |
| `textDocument/prepareTypeHierarchy` | [type_hierarchy.rs:18](../../src/type_hierarchy.rs#L18) | ✅ | ✅ **(this plan)** | [FS-TYPEHIER-PREPARE] |
| `typeHierarchy/supertypes` | [type_hierarchy.rs:58](../../src/type_hierarchy.rs#L58) | ✅ | ✅ **(this plan)** | [FS-TYPEHIER-SUPER] |
| `typeHierarchy/subtypes` | [type_hierarchy.rs:93](../../src/type_hierarchy.rs#L93) | ✅ | ✅ **(this plan)** | [FS-TYPEHIER-SUB] |
| `textDocument/references` | [semantic.rs](../../src/semantic.rs) | ✅ solution-wide | ✅ **project-wide (this plan)** | [FS-REFS-PROJECT] |
| `textDocument/hover` | [semantic.rs:134](../../src/semantic.rs#L134) | ✅ | ✅ | — |
| `textDocument/definition` etc. | [main.rs:657](../../src/main.rs#L657) | ✅ | ✅ | — |
| `textDocument/typeDefinition` | nav | ✅ | ✅ | — |
| `textDocument/declaration` | nav | ✅ | ✅ | — |
| `textDocument/implementation` | nav | ✅ | ✅ | — |
| `textDocument/documentHighlight` | nav | ✅ | ✅ | — |
| `textDocument/codeAction` + resolve | [code_actions.rs](../../src/code_actions.rs) | ✅ | ✅ | — |
| `textDocument/semanticTokens/{full,range}` | [semantic_tokens.rs](../../src/semantic_tokens.rs) | ✅ | ✅ | — |
| `textDocument/inlayHint` | [inlay_hints.rs](../../src/inlay_hints.rs) | ✅ | ✅ | — |
| `workspace/diagnostics` (pull) | [pull_diagnostics.rs](../../src/pull_diagnostics.rs) | ✅ | ✅ | — |
| `project/unusedPackages` | [nuget](../../src/nuget) | ✅ | ✅ | — |

### Not routed by the Rust host (parity N/A)

These are registered by one or both sidecars but the Rust host never forwards them,
so they are out of scope for parity until the host wires them:

- `textDocument/formatting`, `rangeFormatting`, `onTypeFormatting` — formatting is
  **intentionally disabled** in the host ([src/main.rs:539](../../src/main.rs#L539));
  use Fantomas (F#) / CSharpier (C#) directly. F# additionally exposes
  `textDocument/formattingPreview` for the diff UI.
- `textDocument/didChange` — the host only notifies the **C#** sidecar
  ([src/main.rs:1050](../../src/main.rs#L1050)). The F# sidecar reads source from
  disk per request. See "Known limitations" below.
- `workspace/diagnostics/all` — C#-only batch path; the host pulls per-document.

## Design notes

### [FS-COMPLETION] / [FS-COMPLETION-RESOLVE]
FCS `FSharpCheckFileResults.GetDeclarationListInfo` drives the list. The partial
identifier is extracted with `QuickParse.GetPartialLongNameEx`. `FSharpGlyph` maps
to the same kind strings the Rust host's `map_completion_kind` understands. Items in
unopened namespaces expose `NamespaceToOpen`, surfaced as an `(open <ns>)` detail
hint (mirrors C#'s `(import) <ns>`). `completionItem/resolve` returns the wire-empty
`AdditionalEdits` for now; **auto-`open` insertion is a follow-up** (see below).

### [FS-RENAME-PREPARE] / [FS-RENAME-APPLY] / [FS-REFS-PROJECT]
Rename and references both need **project-wide** symbol uses, not just the current
file. A shared `getProjectUsages` helper runs `ParseAndCheckProject` and
`GetUsesOfSymbol` so `textDocument/references` becomes project-wide (was current-file
only) and rename rewrites every occurrence. `prepareRename` refuses symbols whose
declaration is outside the loaded project (BCL / FSharp.Core / NuGet).

### [FS-CODELENS]
A reference-count lens above every top-level definition (functions, values, types,
union cases, members). Counts come from project-wide uses; the title format
(`"N references"`) matches C#'s `CodeLensResolver`.

### [FS-CALLHIER-*]
FCS has no built-in call graph, so the enclosing caller/callee is resolved from the
untyped AST (`ParsedInput`) via `SyntaxTraversal`: incoming = project-wide call sites
of the symbol mapped to their enclosing binding/member; outgoing = function/member
applications inside the symbol's own binding range. Kind strings are capitalized to
match the host's `parse_symbol_kind`.

### [FS-TYPEHIER-*]
Supertypes come from `FSharpEntity.BaseType` + `AllInterfaces`. Subtypes are found by
scanning project entities for any whose base type or interfaces include the target.

## Known limitations / follow-ups

- **Unsaved-buffer fidelity** — the host does not send `textDocument/didChange` to
  the F# sidecar, so F# semantic results reflect on-disk content. Wiring
  `notify_did_change` to the F# sidecar + an in-memory overlay is a separate change
  (tracked here, not in this parity pass).
- **Completion auto-`open`** — `completionItem/resolve` should insert the `open` for
  `NamespaceToOpen` items; deferred until the host's resolve wire carries it cleanly.
- **Cross-language hierarchies** — F#↔C# call/type hierarchy edges require a unified
  symbol index; both sidecars stay single-language for now.

## Pre-existing backlog (unchanged)

- [ ] Ionide.ProjInfo integration for project cracking (currently manual `.fsproj`
      XML parse in [FSharpWorkspace.fs:41](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpWorkspace.fs#L41))
- [ ] File ordering awareness + reorder suggestions (F# compilation order matters)
- [ ] Type provider navigation support
- [ ] Convert pipe to/from nested function calls (refactoring)

## TODO — parity pass

- [ ] [FS-COMPLETION] `textDocument/completion` via `GetDeclarationListInfo`
- [ ] [FS-COMPLETION-RESOLVE] `completionItem/resolve` (wire-empty edits + ns hint)
- [ ] [FS-REFS-PROJECT] project-wide `textDocument/references`
- [ ] [FS-RENAME-PREPARE] `textDocument/prepareRename`
- [ ] [FS-RENAME-APPLY] `textDocument/rename` (project-wide edits)
- [ ] [FS-CODELENS] `textDocument/codeLens` reference counts
- [ ] [FS-CALLHIER-PREPARE] `textDocument/prepareCallHierarchy`
- [ ] [FS-CALLHIER-INCOMING] `callHierarchy/incomingCalls`
- [ ] [FS-CALLHIER-OUTGOING] `callHierarchy/outgoingCalls`
- [ ] [FS-TYPEHIER-PREPARE] `textDocument/prepareTypeHierarchy`
- [ ] [FS-TYPEHIER-SUPER] `typeHierarchy/supertypes`
- [ ] [FS-TYPEHIER-SUB] `typeHierarchy/subtypes`
- [ ] e2e tests for every method above (real `.fsproj`, IPC round-trip)
</content>
</invoke>
