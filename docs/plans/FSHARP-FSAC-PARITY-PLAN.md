# F# ⇄ FSAC Parity Plan — match FsAutoComplete, then go beyond

**Goal #2 of the project: treat F# as a first-class citizen.** This plan is the
authoritative, cross-referenced map of every capability
[FsAutoComplete (FSAC)](https://ionide.io/Tools/fsac.html) — the engine behind
Ionide — exposes, against what the SharpLsp F# (FCS) sidecar provides today, and
the prioritized work to reach **superior** parity (every FSAC feature, plus the
things FSAC has never had).

It is the shared source of truth for three lanes:
- **Website docs** (the public F# parity page) — owned by SharpLsp3.
- **F# sidecar implementation** — owned by the F# sidecar lane (fsharp-parity-opus).
- **Analyzers / config** — `[analyzers]` + dead-code work (SharpLsp1).

**Related plan:** [FSHARP-FEATURES-PLAN.md](FSHARP-FEATURES-PLAN.md) tracks the
*internal* C# (Roslyn) ⇄ F# (FCS) parity — every host-routed method working
identically for `.cs` and `.fs`. **This** doc tracks the *external* target:
matching and beating **FsAutoComplete/Ionide**. Complementary — keep the
internal-parity matrix there and the FSAC-parity matrix here; do not duplicate.

Spec IDs use the `[FSAC-PARITY-*]` group; existing per-feature IDs (`[FS-*]`,
`[PKG-*]`) are referenced where they already implement a row.

## How F# requests are served

The Rust host ([src/main.rs](../../src/main.rs)) routes each LSP method to exactly
one sidecar by document language (`pick_sidecar`): `.fs`/`.fsx`/`.fsi` → F# (FCS)
sidecar, everything else → C# (Roslyn). A method is "at parity" only when the F#
sidecar registers it **and** returns a wire-compatible payload. Unregistered
routed methods silently return nothing for `.fs` files — that is a parity gap.

## Parity matrix

Legend: ✅ have · 🟡 partial · ❌ missing · ⭐ beyond FSAC (we have, FSAC does not).

### Core language — `[FSAC-PARITY-CORE]`

| FSAC capability | LSP method | SharpLsp | Spec / notes |
|---|---|---|---|
| Completion + resolve | `textDocument/completion`, `completionItem/resolve` | ✅ / 🟡 | `[FS-COMPLETION]`; auto-`open` insertion on resolve still stubbed `[FS-COMPLETION-RESOLVE]` |
| Go to definition | `textDocument/definition` | ✅ | e2e: `test_full_stack_fsharp_navigation` |
| Type definition | `textDocument/typeDefinition` | 🟡 | returns null in cases — **gap [#112]** |
| Implementation | `textDocument/implementation` | ✅ | |
| Declaration | `textDocument/declaration` | ⭐✅ | not in FSAC's list |
| Find references | `textDocument/references` | 🟡 | `[FS-REFS-PROJECT]` project-wide, but use-site completeness on types — **gap [#112]** |
| Hover | `textDocument/hover` | ✅ | XML-doc rendering; e2e covered |
| Signature help | `textDocument/signatureHelp` | ✅ | `[FS-SIGHELP]` |
| Document symbols | `textDocument/documentSymbol` | ✅ | `[FS-DOCSYMBOL]` (parse-only) |
| Workspace symbols | `workspace/symbol` | ✅ | `[FS-WORKSPACE-SYMBOL]` — F# files routed to the FCS sidecar's document symbols (Ctrl-T); host has no F# tree-sitter grammar |
| Document highlight | `textDocument/documentHighlight` | ✅ | file-local read/write classification |
| Diagnostics | pull (`textDocument`/`workspace` diagnostic) | ✅ | FCS compiler diagnostics, `FS####` codes |

### Refactoring, code fixes & formatting — `[FSAC-PARITY-FIX]`

| FSAC capability | SharpLsp | Spec / notes |
|---|---|---|
| Rename | ⭐✅ | `[FS-RENAME-PREPARE]`/`[FS-RENAME-APPLY]` — **project-wide** (FSAC is file-local) |
| Resolve namespace (auto-`open`) | ✅ | FS0039 `open` suggestions |
| Replace unused symbol with `_` | ✅ | FS1182 |
| Generate DU match cases | ✅ | union-case stub generation |
| Generate record stub | ✅ | record-field stub generation |
| Remove unused `open` | ✅ | `[FS-CODEFIX-UNUSEDOPEN]` — quick fix for the `SLSPF0102` hint (deletes the `open` line) |
| Remove redundant qualifiers (`SimplifyName`) | ✅ | `[FS-CODEFIX-SIMPLIFYNAME]` — quick fix for the `SLSPF0103` hint (strips the qualifier prefix) |
| Fix typo from compiler error ("did you mean") | ❌ | **gap** |
| Add missing `new` for `IDisposable` | ❌ | **gap** |
| Generate interface implementation | ✅ | `[FS-CODEFIX-INTERFACESTUB]` — FCS `InterfaceStubGenerator` ("Implement interface"), completes the union/record/interface stub trio |
| Extra fixes beyond FSAC list | ⭐✅ | FS0020 `\|> ignore`, FS0025 wildcard arm, FS0026 remove redundant case, FS0001 type conversion |
| Formatting via Fantomas | 🟡 | implemented in `FSharpFeatures.fs` but **sequestered** — not routed by host. **gap: enable routing** |
| Code lens (reference counts) | ✅ | `[FS-CODELENS]` |
| Code lens (signature) | 🟡 | reference-count only; signature lens missing |

### Analysis & advanced — `[FSAC-PARITY-ADVANCED]`

| FSAC capability | SharpLsp | Spec / notes |
|---|---|---|
| Unused declarations analyzer | ✅ | `[FS-ANALYZER-DEADCODE]` (monorepo-aware; SharpLsp1 extending) |
| Unused opens analyzer | ✅ | `[FS-ANALYZER-UNUSEDOPEN]` — `SLSPF0102` hint (`UnusedOpens.getUnusedOpens`) |
| SimplifyName analyzer | ✅ | `[FS-ANALYZER-SIMPLIFYNAME]` — `SLSPF0103` hint (`SimplifyNames.getSimplifiableNames`) |
| FSharpLint linting | ❌ | **gap** — in tech stack (`FSharpLint.Core`), not yet wired |
| FSI / `.fsx` script type-check (`UseSdkScripts`, `fsiExtraParameters`) | 🟡 | `.fsx`/`.fsi` recognized + routed; full FSI script checking missing — **gap** |
| `fsharp/workspacePeek` / `workspaceLoad` / `project` / `compile` | 🟡 | workspace loading + `.fsproj` cracking exist; Ionide custom endpoints not exposed |
| `fsharp/documentation` / `f1Help` / `fsdn` | ❌ | **gap** — info-panel + FSDN search endpoints |
| `fsharp/compilerLocation` | ❌ | **gap** |
| Inlay hints | ⭐✅ | type + parameter + pipeline hints (FSAC has type hints; ours are broader) |
| Semantic tokens | ✅ | full + range |

### Beyond FSAC (SharpLsp-only) — `[FSAC-PARITY-BEYOND]`

| Capability | Spec |
|---|---|
| Call hierarchy (incoming/outgoing) | `[FS-CALLHIER-PREPARE/INCOMING/OUTGOING]` — FSAC has none |
| Type hierarchy (super/subtypes) | `[FS-TYPEHIER-PREPARE/SUPER/SUB]` — FSAC has none |
| Project-wide references & rename | `[FS-REFS-PROJECT]`, `[FS-RENAME-*]` |
| Monorepo dead-code (errors vs warnings) | `[FS-ANALYZER-DEADCODE]` |
| Unused NuGet package detection | `[PKG-UNUSED-DETECT-FS]` |
| F# file-order dependency analysis | `FSharpFileOrder.fs` |

## Prioritized gap backlog

Each item is sized to one focused change with e2e + sidecar tests.

1. **references/typeDefinition completeness** — `[#112]` (F# sidecar lane). _Re-verified still open 2026-06-22: refs on the `Shape` type returns only the declaration. Rename (which shares `getProjectUsages`) works, so the gap is specific to type/entity use-site collection in references._
2. ~~**workspace/symbol** for F#~~ — ✅ **done** `[FS-WORKSPACE-SYMBOL]`: F# files route to the
   FCS sidecar's document symbols inside the standard `workspace/symbol` handler
   ([main.rs](../../src/main.rs) `collect_fsharp_ws_symbols`,
   [document_symbols.rs](../../src/document_symbols.rs) `fsharp_workspace_symbols`).
3. **FSharpLint integration** — wire `FSharpLint.Core` into the diagnostics pipeline.
4. ~~**Unused-opens** analyzer + "remove unused open" code fix.~~ — ✅ **done**: analyzer
   `[FS-ANALYZER-UNUSEDOPEN]` (`SLSPF0102`) + fix `[FS-CODEFIX-UNUSEDOPEN]`.
5. ~~**SimplifyName** analyzer + "remove redundant qualifier" code fix.~~ — ✅ **done**: analyzer
   `[FS-ANALYZER-SIMPLIFYNAME]` (`SLSPF0103`) + fix `[FS-CODEFIX-SIMPLIFYNAME]`.
6. ~~**Interface-implementation stub** code action~~ — ✅ **done** `[FS-CODEFIX-INTERFACESTUB]`: FCS
   `InterfaceStubGenerator` ("Implement interface"), completing the union/record/interface stub trio
   ([FSharpCodeActions.fs](../../sidecars/SharpLsp.Sidecar.FSharp/FSharpCodeActions.fs) `tryGenerateInterfaceStub`).
7. **Fantomas formatting** — un-sequester: route `textDocument/formatting` + `rangeFormatting` to the F# sidecar.
8. **Compiler-error typo fix** ("did you mean") + **add `new` for IDisposable**.
9. **FSI/`.fsx`** full script type-checking incl. `fsiExtraParameters`.
10. **Ionide custom endpoints**: `documentation`, `f1Help`, `fsdn`, `compilerLocation`, `workspacePeek`.
11. **completion auto-`open`** insertion `[FS-COMPLETION-RESOLVE]` — **blocked on unopened-symbol
    completion.** `GetDeclarationListInfo` is currently called with an empty `getAllEntities`
    (`fun () -> []`), so completion never surfaces items in unopened namespaces and
    `DeclarationListItem.NamespaceToOpen` is always `None`. Real auto-`open` needs an
    assembly-content/entity index (FSAC's `AssemblyContentProvider`) feeding `getAllEntities`,
    then a per-file resolve cache mapping the item index → the `open` insertion edit
    (computed via `ParsedInput.FindNearestPointToInsertOpenDeclaration`). Sized as its own change.
    Tracked: [#122](https://github.com/Nimblesite/SharpLsp/issues/122).

## E2E coverage status (`[FSAC-PARITY-E2E]`)

Rust-host full-stack F# e2e lives in
[tests/e2e_modules/fsharp.rs](../../tests/e2e_modules/fsharp.rs) and drives the
real `sharplsp` host + F# sidecar against `create_fsharp_test_workspace`.

| Feature | E2E test | Status |
|---|---|---|
| Hover (fn/type/module, DU, pipeline, XML docs) | `test_full_stack_fsharp_hover_*` | ✅ |
| Definition / typeDefinition / references / highlight | `test_full_stack_fsharp_navigation` | ✅ (typeDef/refs gaps → #112) |
| documentSymbol / completion / signatureHelp / codeLens / inlayHint / semanticTokens | `test_full_stack_fsharp_language_surface` | ✅ |
| Call hierarchy + type hierarchy | `test_full_stack_fsharp_hierarchies` | ✅ |
| Rename (prepare + project-wide apply) | `test_full_stack_fsharp_rename` | ✅ |
| Extension routing (.fs/.fsx/.fsi), no-sidecar nulls | `test_fsharp_*`, `coverage_boost*` | ✅ |

**TODO — e2e to add as the impl lands each gap:**
- [x] rename (prepare + apply) full-stack — `test_full_stack_fsharp_rename`
- [x] code actions / quick fixes — remove-unused-open + simplify-name (F# sidecar IPC suite
      `code action offers …` + VSIX `F# LSP — Code Fixes`)
- [ ] diagnostics content (FS#### codes) full-stack
- [x] workspace/symbol — `test_full_stack_fsharp_workspace_symbol` (Rust e2e) + VSIX
      `F# LSP — Workspace Symbol`
- [ ] formatting once un-sequestered
- [ ] FSharpLint diagnostics once wired

## TODO — parity checklist

- [x] Authoritative FSAC feature study (this matrix)
- [x] Audit current F# sidecar vs FSAC
- [x] Expand F# Rust-host e2e (navigation, language surface, hierarchies) — all green
- [x] File first parity gap (`#112`)
- [x] Backlog item 2 (workspace/symbol), 4 (remove unused open), 5 (simplify name)
- [ ] Backlog items 1, 3, 6–11 above (F# sidecar lane; 11 = auto-`open`, blocked on the entity index)
- [ ] Public F# parity page on the website (SharpLsp3) — mirror this matrix
- [ ] Keep this matrix in lockstep as gaps close (flip 🟡/❌ → ✅, add e2e rows)
