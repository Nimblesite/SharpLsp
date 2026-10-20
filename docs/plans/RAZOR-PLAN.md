# Razor and Blazor Implementation Plan

**Spec:** [RAZOR-SPEC.md](../specs/RAZOR-SPEC.md)

## Context

SharpLsp has not supported `.razor` or `.cshtml` files until now. Research confirmed three things ([RAZOR-RESEARCH]):

- The SDK's own Razor source generator already runs inside the C# sidecar's design-time workspace.
- Its enhanced `#line` directives map every C# fragment back to Razor.
- The public compiler IR supplies everything the mapping misses.

So the C# sidecar owns Razor end to end, the host routes the documents to it, and the editors sync and forward HTML.

The phases below are in dependency order. Each item is checked only when a test that exercises it passes.

## TODO

### Phase 1: Foundation

- [x] Fixture solution `src/sharplsp/tests/fixtures/razor/` with `BlazorApp`, `Widgets` (RCL), `PagesApp` (Pages + MVC) and `Domain` (F#), isolated by its own `Directory.Build.props` ([RAZOR-TESTING])
- [x] Host: add `LangId::Razor` for `.razor` and `.cshtml`, owned by the C# sidecar ([RAZOR-ARCHITECTURE-ROUTING])
- [x] Host: route `documentSymbol`, `foldingRange` and `linkedEditingRange` for Razor to the sidecar, and answer `selectionRange` empty
- [x] Host: add `<` and `@` completion triggers, and short-circuit them for C# and F# documents
- [x] Host: publish Razor diagnostics under the source `sharplsp-razor`
- [x] Sidecar: bundle the Razor compiler from the build SDK, and list it in `THIRD-PARTY-NOTICES.md` ([RAZOR-ARCHITECTURE-ENGINE])
- [x] Sidecar: find Razor files as additional documents, and sync their text in every framework context, including the pending-edit replay ([RAZOR-ARCHITECTURE-DOCUMENTS])
- [x] Sidecar: build the C# projection — find the generated document by its checksum pragma, and build the verified span map in both directions ([RAZOR-ARCHITECTURE-PROJECTION])
  - [x] Verify the checksum lookup, the mappings that never map (hidden, fileless, foreign, outside either text), carets at a fragment's end, and rename's check that a span holds the old name — `RazorProjectionTests`: 6 passing cases over hand-written generator output
- [x] Sidecar: build the Razor engine per project — configuration from the analyzer and parse options, an in-memory file system, tag helpers per compilation, the capture pass and markup facts
  - [x] Verify configuration fallbacks, target-path metadata, current file/import reads, missing files, missing paths, cancellation and failure recovery — `RazorEngineSettingsTests`: 12 passing cases; settings, filesystem and engine each have 100% line coverage
- [x] Sidecar: build the HTML projection and the markup-context tokenizer ([RAZOR-ARCHITECTURE-HTML])
  - [x] HTML projection from compiler IR, preserving offsets/newlines and current unsaved text — `RazorHtmlProjectionTests`: 19 passing fixture cases (Blazor and MVC, comments, UTF-16, incomplete tags, unsaved edits)
  - [x] HTML markup-context tokenizer — `HtmlMarkupContextTests`: 36 passing cases with 100% line coverage, including malformed start/end tag recovery; the three character-reconsumption regressions were verified failing before the fix and pass unchanged afterward
  - [x] Host: `sharplsp/razor/htmlProjection` answers `{ text }`, or `null` for a file no project lists — `test_full_stack_razor_routing_session`
  - [x] Verify `sharplsp/razor/htmlProjection` through editor integration — `razor-lsp.test.ts`: the projection keeps the editor's offsets, line breaks and unsaved text, and feeds VS Code's HTML completion and hover

- [ ] Sidecar: Razor C# features answer whatever SDK a project resolves (#399). When the project's SDK Razor generator was built against a newer Roslyn than the sidecar's, the bundled Razor compiler loads in its place, and a warning names both Roslyn versions ([RAZOR-ARCHITECTURE-GENERATOR])
  - [x] Root cause: a newer SDK's Razor compiler has a higher assembly version than the bundled copy. Roslyn's analyzer loader stands the sidecar's own copy in only once that copy is loaded. Otherwise it loads the SDK's copy, finds it references a newer `Microsoft.CodeAnalysis`, and refuses it for the session. xUnit's discovery always loads the bundled copy before any test runs, which is why the sidecar's own Razor tests passed on runners with SDK 10.0.401 while the end-to-end suites failed
  - [x] Failing tests, failing for the bug: `RazorNewerSdkTests` gives the fixture's design-time builds a newer SDK's Razor compiler (a higher assembly version that references a newer Roslyn). In a fresh sidecar process, hover in `Counter.razor` answers null: the process loads that compiler from the SDK's folder, never its own copy, and Roslyn refuses it. In process, the projects keep the newer SDK's generator files. The fixture copies now keep the repository's SDK pin, as the editor suites' copies do
  - [x] Fix: at project load, an SDK Razor compiler that references a newer `Microsoft.CodeAnalysis` than the running one is swapped, with its two companion files, for the bundled copies, and a warning names both versions (`RazorGenerator`, Codex1, 029fc3a)
  - [x] Pass: the two failing tests pass unchanged, and a third proves a compiler that cannot be read leaves the project as it loaded
  - [ ] Full sidecar suite and coverage gates with the fix
  - [ ] CI proof on a real newer SDK: a Rust end-to-end Razor test whose fixture copy keeps no SDK pin, so runners carrying SDK 10.0.401 load it with that SDK (Codex1, 029fc3a; awaits CI)
  - [ ] Docs and blog: drop the advice to pin SDK 10.0.303 once the fix lands (Claude1)

**Validation (2026-10-20):** the Release sidecar solution builds with zero warnings and errors; 671 C#, 440 F# and 125 Common tests pass, and all three coverage gates pass. C# coverage is 96.39%, with all 1,530 new C# executable lines covered. `RazorSidecarTests` exercises the real IPC contract and malformed-request recovery; `RazorCompletionEditsTests` covers mapped edits, import deduplication, aliases, static imports and LF/CRLF insertion.

**Editor validation (2026-10-20):** the final Razor chunk passes all 6 cases, the workspace chunk passes all 446 cases (including server-start lifecycle), the debugger chunk passes all 80 cases, and editor lint and formatting pass. The debugger group-outcome test that previously timed out passes unchanged in the full chunk in 6.5 seconds.

**Template validation (2026-10-20):** the real host and sidecars run over a fresh `dotnet new blazor` app (.NET 10). Its files report no errors and keep their shape in the HTML projection. Hover, definition, references, member completion and signature help answer on its real code: layouts, `@inherits`, `@Body`, `NavLinkMatch`, `@Assets`, `typeof(Program)`. The one false report found was usings marked unnecessary: every using in `_Imports.razor`, and, as review showed, a component's usings that only its markup needs. Razor files no longer report unnecessary usings (`Import_files_never_report_their_usings_as_unnecessary`, `Components_never_report_a_using_their_markup_may_need_as_unnecessary`).

### Phase 2: C# Inside Razor

- [ ] Diagnostics: C# diagnostics from projections, `RZ` diagnostics from facts, and Razor files in solution-wide diagnostics ([RAZOR-FEATURES-DIAGNOSTICS])
- [x] Hover at mapped positions ([RAZOR-FEATURES-HOVER])
- [ ] Definition, type definition, declaration and implementation from mapped positions, with generated component classes landing in their `.razor` file ([RAZOR-FEATURES-DEFINITION])
- [x] References and document highlights across projections, with hidden scaffolding dropped ([RAZOR-FEATURES-REFERENCES])
- [x] C# completion, with mapped edits and `using` → `@using` ([RAZOR-FEATURES-COMPLETION])
  - [x] Completion right after a typed dot offers members: `@scores.` and an unclosed `@(scores.` (#401, review R2). Red tests `RazorCompletionRecoveryTests` (Codex1) failed for the bug, then passed unchanged once completion asks a copy of the file with the expression finished at the caret (Claude2). An unclosed `@{` already completed and is kept as a control
  - [ ] Coverage gates with the #401 fix; the full C# sidecar suite passes with it
- [x] Signature help ([RAZOR-FEATURES-SIGNATURE-HELP])
  - [x] Signature help after `@(` no longer lists the generator's scaffolding (`AddContent`, `AddAttribute`) (#400, review R1, Codex1): the regression cases failed for the bug, then passed unchanged
- [x] Semantic tokens for C# fragments ([RAZOR-FEATURES-SEMANTIC-TOKENS])
- [ ] Rename and prepareRename — Razor usages and `@code` declarations, from `.cs` and `.razor` origins ([RAZOR-FEATURES-RENAME])
  - [x] Escaped identifiers (`@class`) get their Razor rename edits (review R4, Codex1): the real-fixture regression failed for the bug, then passed unchanged

### Phase 3: Blazor Markup

- [ ] Component tags: hover, definition, references, highlights and linked editing
- [ ] Component attributes and `@bind-X`: hover, definition, references and rename
- [ ] Directive attributes and directives: hover
- [ ] Completion: components, parameters (with `[EditorRequired]` first), `@bind-X`, directive attributes and their parameters, and directives
- [ ] Semantic tokens for markup: component tags, attributes, directive attributes and directives
- [ ] Folding ranges and document symbols ([RAZOR-FEATURES-STRUCTURE])

### Phase 4: Razor Pages and MVC

- [ ] `@model`, `@inject`, `@section` and `@functions` through the projection ([RAZOR-MVC])
- [ ] Tag helper elements and attributes: hover and completion
- [ ] `_ViewImports.cshtml` imports resolved by the engine

### Phase 5: Editors

- [x] VS Code: sync `razor` and `aspnetcorerazor` documents, and activate on `onLanguage:razor` ([RAZOR-EDITORS]) — `razor-lsp.test.ts`: a Razor file opens as Razor, and its unsaved edits reach the server
- [x] VS Code: forward HTML completion and hover over `sharplsp/razor/htmlProjection` ([RAZOR-FEATURES-HTML]) — `razor-lsp.test.ts`: element names and HTML hovers in markup, C# completion and hover in code
- [x] VS Code: add a `razor` end-to-end chunk on both platforms — `test-chunks.json`, in both matrices
- [x] Zed: Razor language registration (Zed has no built-in Razor grammar) — `the_server_attaches_to_the_csharp_fsharp_and_razor_languages`

### Phase 6: F#

- [ ] Hover, completion and definition from Razor into F# types of a referenced F# project ([RAZOR-FSHARP])
- [ ] F#-origin rename that includes Razor usages, mapped back from the projections

### Deferred ([RAZOR-FEATURES-DEFERRED])

- [ ] Razor formatting
- [ ] Selection ranges
- [ ] Code actions: extract a block to code-behind, extract a component, generate an event handler, add `@using`
- [ ] Inlay hints, code lens, and call and type hierarchy from Razor positions
- [ ] `.razor.css` and `.razor.js` collocation awareness
- [ ] Blazor WebAssembly debugging and Razor Hot Reload
