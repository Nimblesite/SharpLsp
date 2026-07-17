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
| `textDocument/documentSymbol` | [document_symbols.rs:20](../../src/document_symbols.rs#L20) | ✅ tree-sitter (host) | ✅ **FCS nav items (this plan)** | [FS-DOCSYMBOL] |
| `workspace/symbol` | [main.rs](../../src/main.rs) `handle_standard_workspace_symbol` | ✅ tree-sitter (host) | ✅ **FCS document symbols** | [FS-WORKSPACE-SYMBOL] |
| `textDocument/signatureHelp` | [signature_help.rs:21](../../src/signature_help.rs#L21) | — | ✅ **FCS GetMethods (this plan)** | [FS-SIGHELP] |
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

## Analyzers & diagnostics — FSAC parity + beyond

Implemented in [FSharpAnalyzers.fs](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpAnalyzers.fs),
merged into the `workspace/diagnostics` handler
([FSharpSidecar.fs](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpSidecar.fs)), configured
by the host via `analyzers/configure`. Full design in
[DIAGNOSTICS-STATIC-ANALYZERS-SPEC](../specs/DIAGNOSTICS-STATIC-ANALYZERS-SPEC.md).

| Analyzer | Code | FSAC has it? | SharpLsp |
|---|---|---|---|
| Unused `open` detection | `SLSPF0102` | ✅ | ✅ |
| Simplify name / redundant qualifier | `SLSPF0103` | ✅ | ✅ |
| Unused symbol detection | `SLSPF0101` | ✅ (file-local) | ✅ **project-wide** |
| **Monorepo dead-code = error** | `SLSPF0101` | ❌ | ✅ **(beyond FSAC)** [ANALYZERS-DEADCODE-SEVERITY] |

The monorepo dead-code gate ([ANALYZERS-MONOREPO-GATE], [ANALYZERS-CONFIG-IMPL]) is
the headline differentiator: when `[analyzers] monorepo = true`, an unreferenced
public symbol is a hard **error** (the repo is the whole world), which no FSAC/Ionide
rule offers. Private/internal dead code is reported even outside monorepo mode.

- [x] [FS-ANALYZER-DEADCODE] monorepo dead-code (`GetAllUsesOfAllSymbols`, config-gated severity)
- [x] [FS-ANALYZER-UNUSEDOPEN] unused `open` detection (FCS `UnusedOpens`)
- [x] [FS-ANALYZER-SIMPLIFYNAME] simplify-name (FCS `SimplifyNames`)
- [x] e2e + unit coverage (dead-code fixture, unused-open fixture, pure-helper unit tests)
- [x] C# parity: Roslyn `SymbolFinder` monorepo dead-code (`SLSPC0101`) + `analyzers/configure`
      ([DeadCodeAnalyzer.cs](../../sidecars/SharpLsp.Sidecar.CSharp/Workspace/DeadCodeAnalyzer.cs),
      5 e2e tests; same `[analyzers]` config flows to both sidecars from the host)
- [x] code fixes: remove-unused-open (`[FS-CODEFIX-UNUSEDOPEN]`) + simplify-name (`[FS-CODEFIX-SIMPLIFYNAME]`)
      — `removeUnusedOpenActions`/`simplifyNameActions` in
      [FSharpCodeFixes.fs](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpCodeFixes.fs), backed by the
      shared [FSharpLocalAnalysis.fs](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpLocalAnalysis.fs)
- [ ] code fixes: safe-delete dead symbol

## Pre-existing backlog (unchanged)

- [ ] Ionide.ProjInfo integration for project cracking (currently manual `.fsproj`
      XML parse in [FSharpWorkspace.fs:41](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpWorkspace.fs#L41))
- [ ] File ordering awareness + reorder suggestions (F# compilation order matters)
- [ ] Type provider navigation support
- [ ] Convert pipe to/from nested function calls (refactoring)
- [ ] Multi-project F# workspace state (multiple `FSharpProjectOptions`). Unblocks
      mixed C#/F# `.slnx` full-stack coverage (migrated from the completed-and-removed
      SLNX-SUPPORT plan, whose only remaining item was gated on this).

## TODO — parity pass

All parity methods are registered in the F# sidecar
([FSharpSidecar.fs](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpSidecar.fs)) and
backed by dedicated modules ([FSharpCompletion.fs](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpCompletion.fs),
[FSharpRename.fs](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpRename.fs),
[FSharpCodeLens.fs](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpCodeLens.fs),
[FSharpHierarchy.fs](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpHierarchy.fs),
[FSharpReferences.fs](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpReferences.fs)),
with the MessagePack wire contract in
[FSharpWire.fs](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpWire.fs).
E2E coverage lives in the F# sidecar IPC round-trip suite
([SidecarEndToEndTests.fs](../../sidecars/SharpLsp.Sidecar.FSharp.Tests/SidecarEndToEndTests.fs)),
which loads a real two-file `.fsproj` over a Unix socket and asserts each method's
MessagePack response (completion, resolve, project-wide references, prepare/apply
rename, code lens, and call/type hierarchy).

- [x] [FS-COMPLETION] `textDocument/completion` via `GetDeclarationListInfo`
- [x] [FS-COMPLETION-RESOLVE] `completionItem/resolve` (wire-empty edits + ns hint)
- [x] [FS-REFS-PROJECT] project-wide `textDocument/references`
- [x] [FS-RENAME-PREPARE] `textDocument/prepareRename`
- [x] [FS-RENAME-APPLY] `textDocument/rename` (project-wide edits)
- [x] [FS-CODELENS] `textDocument/codeLens` reference counts
- [x] [FS-CALLHIER-PREPARE] `textDocument/prepareCallHierarchy`
- [x] [FS-CALLHIER-INCOMING] `callHierarchy/incomingCalls`
- [x] [FS-CALLHIER-OUTGOING] `callHierarchy/outgoingCalls`
- [x] [FS-TYPEHIER-PREPARE] `textDocument/prepareTypeHierarchy`
- [x] [FS-TYPEHIER-SUPER] `typeHierarchy/supertypes`
- [x] [FS-TYPEHIER-SUB] `typeHierarchy/subtypes`
- [x] [FS-DOCSYMBOL] `textDocument/documentSymbol` via FCS `GetNavigationItems` (parse-only; host routes `.fs` to the sidecar, `.cs` stays tree-sitter)
- [x] [FS-SIGHELP] `textDocument/signatureHelp` via FCS `GetMethods` (capability advertised; overloads surfaced)
- [x] [FS-CHECK-VERSION-GATE] current-text-safe FCS checks: overlay-stability retry (the operative safeguard) + truthful monotonic `fileVersion` metadata; all per-file analyses funnel through `checkFileWithParse`/`parseAndCheckOnce` (GitHub #160, sidecar-side complement of `[DIAG-PUSH-GATE]`)
- [x] e2e tests for every method above (real `.fsproj`, IPC round-trip)

> **Routing note:** `callHierarchy/incomingCalls`/`outgoingCalls` and
> `typeHierarchy/super`/`subtypes` carry the document URI inside `params.item`,
> not `params.textDocument`. `extract_document_uri`
> ([main.rs](../../src/main.rs)) now also reads `params.item.uri` so these
> follow-up requests route to the **F#** sidecar instead of defaulting to C#.

