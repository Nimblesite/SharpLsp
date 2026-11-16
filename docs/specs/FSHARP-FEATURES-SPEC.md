# F# Language Features Spec

F# is a **first-class citizen**: every LSP capability the Rust host routes works for `.fs` as it does
for `.cs`. This spec fixes how each routed method reaches the F# sidecar (FCS) and what it answers.
The external target, FsAutoComplete parity, is tracked in
[FSHARP-FSAC-PARITY-PLAN.md](../plans/FSHARP-FSAC-PARITY-PLAN.md).

## How requests reach a sidecar

The Rust host ([src/sharplsp/src/dispatch.rs](../../src/sharplsp/src/dispatch.rs)) routes each LSP method to **one**
sidecar chosen purely by document language (`pick_sidecar` in that file): `.fs` → F# sidecar, everything else → C# sidecar. The wire
contract for every method is fixed by the Rust handler's MessagePack request/response
structs (positional, `[Key(n)]`-ordered). A sidecar reaches parity for a method by
registering that method name and returning a wire-compatible payload. If the F#
sidecar does **not** register a routed method, `.fs` files silently get nothing for
that feature — that is the parity gap.

## Parity matrix (routed LSP methods)

| LSP method | Rust handler | C# (Roslyn) | F# (FCS) | Spec |
|---|---|---|---|---|
| `textDocument/completion` | [semantic/completion.rs](../../src/sharplsp/src/semantic/completion.rs) | ✅ | ✅ | [FS-COMPLETION] |
| `completionItem/resolve` | [semantic/completion.rs](../../src/sharplsp/src/semantic/completion.rs) | ✅ | ✅ | [FS-COMPLETION-RESOLVE] |
| `textDocument/prepareRename` | [semantic/rename.rs](../../src/sharplsp/src/semantic/rename.rs) | ✅ | ✅ | [RENAME-FSHARP-PREPARE] |
| `textDocument/rename` | [semantic/rename.rs](../../src/sharplsp/src/semantic/rename.rs) | ✅ | ✅ | [RENAME-FSHARP-APPLY] |
| `textDocument/codeLens` | [code_lens.rs:15](../../src/sharplsp/src/code_lens.rs#L15) | ✅ | ✅ | [FS-CODELENS] |
| `textDocument/prepareCallHierarchy` | [call_hierarchy.rs:19](../../src/sharplsp/src/call_hierarchy.rs#L19) | ✅ | ✅ | [FS-CALLHIER-PREPARE] |
| `callHierarchy/incomingCalls` | [call_hierarchy.rs:59](../../src/sharplsp/src/call_hierarchy.rs#L59) | ✅ | ✅ | [FS-CALLHIER-INCOMING] |
| `callHierarchy/outgoingCalls` | [call_hierarchy.rs:108](../../src/sharplsp/src/call_hierarchy.rs#L108) | ✅ | ✅ | [FS-CALLHIER-OUTGOING] |
| `textDocument/prepareTypeHierarchy` | [type_hierarchy.rs:18](../../src/sharplsp/src/type_hierarchy.rs#L18) | ✅ | ✅ | [FS-TYPEHIER-PREPARE] |
| `typeHierarchy/supertypes` | [type_hierarchy.rs:58](../../src/sharplsp/src/type_hierarchy.rs#L58) | ✅ | ✅ | [FS-TYPEHIER-SUPER] |
| `typeHierarchy/subtypes` | [type_hierarchy.rs:93](../../src/sharplsp/src/type_hierarchy.rs#L93) | ✅ | ✅ | [FS-TYPEHIER-SUB] |
| `textDocument/references` | [semantic.rs](../../src/sharplsp/src/semantic.rs) | ✅ solution-wide | ✅ **project-wide (this plan)** | [REFERENCES-FSHARP-FIND] |
| `textDocument/hover` | [semantic/hover.rs](../../src/sharplsp/src/semantic/hover.rs) | ✅ | ✅ | — |
| `textDocument/definition` etc. | [dispatch.rs](../../src/sharplsp/src/dispatch.rs) `handle_nav_request` | ✅ | ✅ | — |
| `textDocument/typeDefinition` | nav | ✅ | ✅ | — |
| `textDocument/declaration` | nav | ✅ | ✅ | — |
| `textDocument/implementation` | nav | ✅ | ✅ | — |
| `textDocument/documentHighlight` | nav | ✅ | ✅ | — |
| `textDocument/codeAction` + resolve | [code_actions.rs](../../src/sharplsp/src/code_actions.rs) | ✅ | ✅ | — |
| `textDocument/semanticTokens/{full,range}` | [semantic_tokens.rs](../../src/sharplsp/src/semantic_tokens.rs) | ✅ | ✅ | — |
| `textDocument/documentSymbol` | [document_symbols.rs:20](../../src/sharplsp/src/document_symbols.rs#L20) | ✅ tree-sitter (host) | ✅ **FCS nav items (this plan)** | [FS-DOCSYMBOL] |
| `workspace/symbol` | [workspace_symbol_query.rs](../../src/sharplsp/src/workspace_symbol_query.rs) | ✅ tree-sitter (host) | ✅ **FCS document symbols** | [FS-WORKSPACE-SYMBOL] |
| `textDocument/signatureHelp` | [signature_help.rs](../../src/sharplsp/src/signature_help.rs) | ✅ semantic model ([SHARPLSP-FEATURES-INTELLIGENCE-SIGNATURE-HELP]) | ✅ **FCS GetMethods (this plan)** | [FS-SIGHELP] |
| `textDocument/inlayHint` | [inlay_hints.rs](../../src/sharplsp/src/inlay_hints.rs) | ✅ | ✅ | — |
| `workspace/diagnostics` (pull) | [pull_diagnostics.rs](../../src/sharplsp/src/pull_diagnostics.rs) | ✅ | ✅ | — |
| `project/unusedPackages` | [nuget](../../src/sharplsp/src/nuget) | ✅ | ✅ | — |

### Not routed by the Rust host (parity N/A)

These are registered by one or both sidecars but the Rust host never forwards them,
so they are out of scope for parity until the host wires them:

- `textDocument/formatting`, `rangeFormatting`, `onTypeFormatting` — formatting is
  **intentionally disabled** in the host ([src/sharplsp/src/main.rs:539](../../src/sharplsp/src/main.rs#L539));
  use Fantomas (F#) / CSharpier (C#) directly. F# additionally exposes
  `textDocument/formattingPreview` for the diff UI.
- `workspace/diagnostics/all` — C#-only batch path; the host pulls per-document.

## Method specifications

### [FS-COMPLETION] / [FS-COMPLETION-RESOLVE]
FCS `FSharpCheckFileResults.GetDeclarationListInfo` drives the list. The partial
identifier is extracted with `QuickParse.GetPartialLongNameEx`. `FSharpGlyph` maps
to the same kind strings the Rust host's `map_completion_kind` understands. Items in
unopened namespaces expose `NamespaceToOpen`, surfaced as an `(open <ns>)` detail
hint (mirrors C#'s `(import) <ns>`). The entities come from the project's references
and its own signature ([FSharpEntityIndex.fs](../../src/sidecars/SharpLsp.Sidecar.FSharp/FSharpEntityIndex.fs)), and
`completionItem/resolve` returns the `open` the item needs
(`[SHARPLSP-FEATURES-INTELLIGENCE-COMPLETION-OPEN]`, #122).

### Rename and references ([RENAME-FSHARP-PREPARE], [RENAME-FSHARP-APPLY], [REFERENCES-FSHARP-FIND])
Rename and references both need **project-wide** symbol uses, not just the current
file. A shared `getProjectUsages` helper runs `ParseAndCheckProject` and
`GetUsesOfSymbol` so `textDocument/references` becomes project-wide (was current-file
only) and rename rewrites every occurrence. `prepareRename` refuses symbols whose
declaration is outside the loaded project (BCL / FSharp.Core / NuGet).

### [FS-CODELENS]
A reference-count lens above every top-level definition (functions, values, types,
union cases, members). Counts come from project-wide uses; the title format
(`"N references"`) matches C#'s `CodeLensResolver`.

### Call hierarchy — [FS-CALLHIER-PREPARE], [FS-CALLHIER-INCOMING], [FS-CALLHIER-OUTGOING]
FCS has no built-in call graph, so the enclosing caller/callee is resolved from the
untyped AST (`ParsedInput`) via `SyntaxTraversal`: incoming = project-wide call sites
of the symbol mapped to their enclosing binding/member; outgoing = function/member
applications inside the symbol's own binding range. Kind strings are capitalized to
match the host's `parse_symbol_kind`.

### Type hierarchy — [FS-TYPEHIER-PREPARE], [FS-TYPEHIER-SUPER], [FS-TYPEHIER-SUB]
Supertypes come from `FSharpEntity.BaseType` + `AllInterfaces`. Subtypes are found by
scanning project entities for any whose base type or interfaces include the target.

### [FS-DOCSYMBOL]
`textDocument/documentSymbol` for `.fs` is served by the F# sidecar from FCS
`GetNavigationItems` — a parse, never a type check, so it stays within the host's
syntax-only latency budget. `.cs` stays on the host's tree-sitter path.

### [FS-SIGHELP]
`textDocument/signatureHelp` uses FCS `GetMethods` at the call site and surfaces every
overload.

### [FS-WORKSPACE-SYMBOL]
The host's standard `workspace/symbol` handler matches C# files with tree-sitter and
routes each open F# file to the F# sidecar's document symbols
(`collect_fsharp_ws_symbols` in `main.rs`, `fsharp_workspace_symbols` in
`document_symbols.rs`), filtering both by the same lower-cased query.

## Known limitation

- **Cross-language hierarchies** — F#↔C# call/type hierarchy edges require a unified symbol index;
  both sidecars answer hierarchies within their own language.
