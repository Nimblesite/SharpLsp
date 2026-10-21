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
- [x] Host: route `documentSymbol`, `foldingRange` and `linkedEditingRange` for Razor to the sidecar, and answer `selectionRange` empty (the Deferred selection-range item has since routed it to the sidecar too)
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
  - [x] The C# in an HTML attribute value (`disabled="@(…)"`) and every directive attribute, including a minimized parameter the compiler gives no span (`@onclick:stopPropagation`) and a binding parameter's value (`@bind:event="oninput"`), is blank in the projection, while the attribute's name, quotes and literal text stay (#407, review R10, Claude2, 694b48c0). Three regressions failed with the fix off, then passed unchanged; the full .NET leg passes and C# coverage ratchets to 95.54%
  - [x] HTML markup-context tokenizer — `HtmlMarkupContextTests`: 36 passing cases with 100% line coverage, including malformed start/end tag recovery; the three character-reconsumption regressions were verified failing before the fix and pass unchanged afterward
  - [x] Host: `sharplsp/razor/htmlProjection` answers `{ text }`, or `null` for a file no project lists — `test_full_stack_razor_routing_session`
  - [x] Verify `sharplsp/razor/htmlProjection` through editor integration — `razor-lsp.test.ts`: the projection keeps the editor's offsets, line breaks and unsaved text, and feeds VS Code's HTML completion and hover

- [x] Sidecar: Razor C# features answer whatever SDK a project resolves (#399). When the project's SDK Razor generator was built against a newer Roslyn than the sidecar's, the bundled Razor compiler loads in its place, and a warning names both Roslyn versions ([RAZOR-ARCHITECTURE-GENERATOR])
  - [x] Root cause: a newer SDK's Razor compiler has a higher assembly version than the bundled copy. Roslyn's analyzer loader stands the sidecar's own copy in only once that copy is loaded. Otherwise it loads the SDK's copy, finds it references a newer `Microsoft.CodeAnalysis`, and refuses it for the session. xUnit's discovery always loads the bundled copy before any test runs, which is why the sidecar's own Razor tests passed on runners with SDK 10.0.401 while the end-to-end suites failed. Confirmed on SDK 10.0.401 itself: its compiler is version 10.4.0.0 and references `Microsoft.CodeAnalysis` 5.9, against the sidecar's 5.6
  - [x] Failing tests, failing for the bug: `RazorNewerSdkTests` gives the fixture's design-time builds a newer SDK's Razor compiler (a higher assembly version that references a newer Roslyn). In a fresh sidecar process, hover in `Counter.razor` answers null: the process loads that compiler from the SDK's folder, never its own copy, and Roslyn refuses it. In process, the projects keep the newer SDK's generator files. The fixture copies now keep the repository's SDK pin, as the editor suites' copies do
  - [x] Fix: at project load, an SDK Razor compiler that references a newer `Microsoft.CodeAnalysis` than the running one is swapped, with its two companion files, for the bundled copies, and a warning names both versions (`RazorGenerator`, Codex1, 029fc3a)
  - [x] Pass: the two failing tests pass unchanged, and a third proves a compiler that cannot be read leaves the project as it loaded
  - [x] Full sidecar suite and coverage gates with the fix: C# 693/693, F# 447/447, Common 125/125; C# coverage 96.50% ratchets its threshold to 95.49%
  - [x] CI proof on a real newer SDK: a Rust end-to-end Razor test whose fixture copy keeps no SDK pin, so runners carrying SDK 10.0.401 load it with that SDK (Codex1, 029fc3a). It passes locally against an isolated real SDK 10.0.401, and in CI: `test_latest_sdk_razor_generator_remains_usable` passes on Rust Shard 2/2 of run 39364686929, whose ubuntu-24.04 image (20261012.334) ships SDK 10.0.401 beside the pinned 10.0.303
  - [x] Docs and blog: drop the advice to pin SDK 10.0.303, and explain the bundled-compiler fallback (Claude1, 8c418ced)

**Validation (2026-10-20):** the Release sidecar solution builds with zero warnings and errors; 671 C#, 440 F# and 125 Common tests pass, and all three coverage gates pass. C# coverage is 96.39%, with all 1,530 new C# executable lines covered. `RazorSidecarTests` exercises the real IPC contract and malformed-request recovery; `RazorCompletionEditsTests` covers mapped edits, import deduplication, aliases, static imports and LF/CRLF insertion.

**Editor validation (2026-10-20):** the final Razor chunk passes all 6 cases, the workspace chunk passes all 446 cases (including server-start lifecycle), the debugger chunk passes all 80 cases, and editor lint and formatting pass. The debugger group-outcome test that previously timed out passes unchanged in the full chunk in 6.5 seconds.

**Template validation (2026-10-20):** the real host and sidecars run over a fresh `dotnet new blazor` app (.NET 10). Its files report no errors and keep their shape in the HTML projection. Hover, definition, references, member completion and signature help answer on its real code: layouts, `@inherits`, `@Body`, `NavLinkMatch`, `@Assets`, `typeof(Program)`. The one false report found was usings marked unnecessary: every using in `_Imports.razor`, and, as review showed, a component's usings that only its markup needs. Razor files no longer report unnecessary usings (`Import_files_never_report_their_usings_as_unnecessary`, `Components_never_report_a_using_their_markup_may_need_as_unnecessary`).

### Phase 2: C# Inside Razor

- [x] Diagnostics: C# diagnostics from projections, `RZ` diagnostics from facts, and Razor files in solution-wide diagnostics ([RAZOR-FEATURES-DIAGNOSTICS])
  - [x] The compiler's `RZ` diagnostics reach the file and the solution scan with LSP severities (Claude2). `RazorDiagnosticsTests` failed for the gap: the scan held no entry for a file whose only diagnostics were Razor's. It passed unchanged once both paths add the markup facts' diagnostics. The full-stack session's new step publishes RZ1034 as an Error and RZ10012 as a Warning under `sharplsp-razor`; it failed against the old sidecar and passes against the new one
- [x] Hover at mapped positions ([RAZOR-FEATURES-HOVER])
- [x] Definition, type definition, declaration and implementation from mapped positions, with generated component classes landing in their `.razor` file ([RAZOR-FEATURES-DEFINITION])
  - [x] `RazorNavigationTests` (Claude2):
    - Type definition from `@ref="tally"` and from the field lands in `Tally.razor`.
    - The declaration of `Dispose` is `IDisposable.Dispose`.
    - The implementations of `@implements IDisposable` include `Board.razor`.
  - [x] Type definition at a declaration's name answered nothing, in C# as well. `TypeDefinitionFromSymbolTests` failed for it, then passed once the resolver falls back to the symbol's type ([DEFINITION-CSHARP-TYPE])
- [x] References and document highlights across projections, with hidden scaffolding dropped ([RAZOR-FEATURES-REFERENCES])
- [x] C# completion, with mapped edits and `using` → `@using` ([RAZOR-FEATURES-COMPLETION])
  - [x] Completion right after a typed dot offers members: `@scores.` and an unclosed `@(scores.` (#401, review R2). Red tests `RazorCompletionRecoveryTests` (Codex1) failed for the bug, then passed unchanged once completion asks a copy of the file with the expression finished at the caret (Claude2). An unclosed `@{` already completed and is kept as a control
  - [x] Coverage gates with the #401 fix; the full C# sidecar suite passes with it
  - [x] Completion inside a call or lambda of an unfinished `@(` offers members (#404, review R8). Red tests from Claude1's report failed for the bug, then passed unchanged once the copy closes every construct Roslyn's parser reads as open, innermost first, and its map keeps the parts of a fragment outside the C# it inserted. Completion now reads the compiler's diagnostics only when the projection's C# does not parse, and forks only the file's active framework
- [x] Signature help ([RAZOR-FEATURES-SIGNATURE-HELP])
  - [x] Signature help after `@(` no longer lists the generator's scaffolding (`AddContent`, `AddAttribute`) (#400, review R1, Codex1): the regression cases failed for the bug, then passed unchanged
- [x] Semantic tokens for C# fragments ([RAZOR-FEATURES-SEMANTIC-TOKENS])
- [x] Rename and prepareRename — Razor usages and `@code` declarations, from `.cs` and `.razor` origins ([RAZOR-FEATURES-RENAME])
  - [x] Escaped identifiers (`@class`) get their Razor rename edits (review R4, Codex1): the real-fixture regression failed for the bug, then passed unchanged
  - [x] `RazorRenameTests` (Claude2):
    - Renaming `Badge.Text` from its code-behind edits `@Text` and Board's `Text=`.
    - Renaming `Tally.Label` turns `@bind-Label` into `@bind-Title`.
    - prepareRename refuses on a component's start and end tags.
  - The F# half of the rename is Phase 5

### Phase 3: Blazor Markup

- [x] Component tags: hover, definition, references, highlights and linked editing (Claude2)
  - Hover: `RazorMarkupHoverTests`. A start or end tag answers its component's type and summary, ranged on the tag name.
  - Definition: `RazorMarkupDefinitionTests`. A tag goes to the component's `.razor` file and its code-behind partial, or a framework component to its decompiled source.
  - References: `RazorMarkupReferencesTests`. A component's references gain every tag that instantiates it, from markup or from C#, in every Razor file, the app's tags of a class-library component included.
  - Highlights: a component's start and end tags highlight with its C# uses.
  - Linked editing: `RazorStructureTests`.
  - Each new test failed against the C#-only answers, then passed unchanged.
- [x] Component attributes and `@bind-X`: hover, definition, references and rename (Claude2)
  - Hover: a parameter answers its property; on `@bind-` the markup answers, ranged on the whole name, and on `Label` the C# the projection maps answers.
  - Definition: `@bind-` goes to the parameter it binds.
  - References: a parameter's references include every `@bind-X` that names it.
  - Rename: `RazorRenameTests`.
- [x] Directive attributes and directives: hover (Claude2). `@onclick` answers its descriptor's documentation and `@page` its directive's description, both from the compiler; HTML answers nothing
- [x] Completion: components, parameters (with `[EditorRequired]` first), `@bind-X`, directive attributes and their parameters, and directives (Claude2, `RazorMarkupCompletionTests`)
  - After `<`, components complete by their short name where their namespace is in scope: imported, the file's own, or one containing it, as the compiler binds them. Otherwise they complete by their full name, with their documentation. Inside a component, its child-content parameters complete too.
  - In a component start tag: the parameters not yet set, `[EditorRequired]` first and marked, then `@bind-X` and the directive attributes.
  - In an element start tag: the directive attributes and each of their parameters (`@bind:event`, `@onclick:preventDefault`).
  - An `@` opening a markup line offers the parser's directives for the file's kind.
  - Every item replaces the name typed at the caret.
  - The host carries the new `documentation` and `sortText` to the client. The full-stack session proves both, and that the required parameter sorts first
- [x] Semantic tokens for markup: component tags, attributes, directive attributes and directives (Claude2, `RazorMarkupTokensTests`)
  - Component tags are classes, their parameters properties, directive attributes decorators and directives keywords.
  - Where a name holds C#, the C# token wins and the markup keeps its part before it, so no tokens overlap.
  - The C# token test now requires a markup line's markup token alone, where it used to require no token at all
- [x] Folding ranges and document symbols ([RAZOR-FEATURES-STRUCTURE]) (Claude2)
  - `RazorStructureTests` covers element, `@code` and `@functions` folds and the outline.
  - C# code blocks (`@{ … }`) did not fold. They do now, from the code nodes the IR holds outside every directive.

### Phase 4: Razor Pages and MVC

- [x] `@model`, `@inject`, `@section` and `@functions` through the projection ([RAZOR-MVC-DIRECTIVES])
  - `RazorMvcTests.Model_inject_and_functions_answer_through_the_projection`: `@model EditModel` and `Model.Title` hover their docs, `@inject` hovers `ILogger<…>`, and `@Shout` goes to its `@functions` declaration.
  - `Model_expressions_and_section_code_get_csharp_features`: `asp-for="Title"` hovers and goes to `EditModel.Title`, finds its 4 references in `Edit.cshtml`, and renames them all with no generated-file edit; `@Model.Price` inside `@section` hovers. `Section_blocks_fold_and_outline` folds and outlines `@section`.
  - Full stack: `test_full_stack_razor_pages_and_mvc_views` (`razor_mvc.rs`).
- [x] Tag helper elements and attributes: hover and completion ([RAZOR-MVC-TAGHELPERS], [RAZOR-MVC-SCOPE])
  - Hover: `Tag_helper_elements_and_attributes_answer_hover_from_their_descriptors` (`<input>` answers `InputTagHelper`, `asp-for` its `ModelExpression`).
  - Completion: `Tag_helper_attributes_complete_in_an_element_start_tag` (`asp-page`, `asp-controller`, `asp-route-`) and `Tag_helper_elements_complete_after_an_open_angle_bracket` (`partial`, `environment`, `a` once, the `th:` prefix, `@removeTagHelper`). That test found components completing after `<` in `.cshtml` files, where no component binds by tag; they no longer do.
  - Scope: `Tag_helper_directives_scope_completion_and_binding`. VS Code: `a Razor Page completes tag helper elements once, before the HTML service` (an element that both HTML and a tag helper name is listed once).
- [x] `_ViewImports.cshtml` imports resolved by the engine ([RAZOR-MVC-IMPORTS]) — `ViewImports_imports_reach_the_views_below_them`: `@model Item` resolves through `Views/_ViewImports.cshtml`'s `@using`, the view reports no error, and its `@addTagHelper` binds `<a>`

### Phase 5: F#

- [x] Hover, completion and definition from Razor into F# types of a referenced F# project ([RAZOR-FSHARP-METADATA], [RAZOR-FSHARP-DEFINITION])
  - Hover shows the F# XML docs: the design-time build references Domain's `refint` assembly, which has no XML, so the sidecar swaps in the built DLL with its documentation. `RazorFSharpTests.Hover_and_signature_help_read_FSharp_symbols_from_their_assembly` and `Completion_offers_FSharp_members_in_markup_and_code`.
  - Definition lands in `Scores.fs`, not decompiled source: the C# sidecar names each F# symbol by assembly and XML doc ID, and the F# sidecar finds its declaration (`workspace/declarationForeign`, [DEFINITION-CROSSLANG-IDENTITY]). `Definition_names_each_FSharp_symbol_for_the_FSharp_sidecar`; F#: `FSharpForeignSymbolsTests`. The C#→F# definition e2e now lands in `Shapes.fs` too.
  - References merge both sides by the same identity (`workspace/referencesForeign`, [REFERENCES-CROSS-LANGUAGE]): `Foreign_references_and_rename_reach_Razor_uses_of_an_FSharp_symbol`.
  - F# references and highlights placed a dotted use (`player.Score`) over its whole path. They now sit on the name, the same span the foreign path reports (`F# references and foreign uses place each use on its name alike`).
- [x] F#-origin rename that includes Razor usages, mapped back from the projections ([RAZOR-FSHARP-RENAME])
  - From F#: `Foreign_references_and_rename_reach_Razor_uses_of_an_FSharp_symbol` renames `Leaders.razor`'s `@player.Score`.
  - From Razor or C#: the rename resolves to the F# symbol and renames it everywhere (`Rename_from_Razor_renames_an_FSharp_symbol_in_CSharp_and_Razor`).
  - Full stack: `test_full_stack_fsharp_in_razor_session` (hover, definition into `Scores.fs`, references with and without the declaration, rename from Razor and from F#). VS Code: `F# symbols in Razor navigate to, find and rename in their F# source`.
  - That full-stack test only restored the fixture, so C# had no `Domain.dll` to read and every F# symbol stayed unresolved ([DEFINITION-CROSSLANG]: the F# project must be built). Its workspace now builds the F# library (`create_razor_workspace_with_fsharp_built`).

### Phase 6: Editors

- [x] VS Code: sync `razor` and `aspnetcorerazor` documents, and activate on `onLanguage:razor` ([RAZOR-EDITORS]) — `razor-lsp.test.ts`: a Razor file opens as Razor, and its unsaved edits reach the server
- [x] VS Code: forward HTML completion and hover over `sharplsp/razor/htmlProjection` ([RAZOR-FEATURES-HTML]) — `razor-lsp.test.ts`: element names and HTML hovers in markup, C# completion and hover in code
  - [x] A C# position offers C# items alone: no word suggestions from the HTML projection, including after a typed dot and inside an unfinished `@(` (#405, review R9, Codex1, fb1fff3). The client sends the caret, and the projection answers null where the compiler-backed completion target is C#, while tag and attribute names stay markup. The host, sidecar and real-editor regressions failed for the bug, then passed unchanged
- [x] VS Code: add a `razor` end-to-end chunk on both platforms — `test-chunks.json`, in both matrices
- [x] Zed: Razor language registration (Zed has no built-in Razor grammar) — `the_server_attaches_to_the_csharp_fsharp_and_razor_languages`

### Deferred

- [x] Razor formatting — resolved as out of scope: SharpLsp formats no language ([SHARPLSP-FEATURES-FORMATTING]), so the spec now says so for Razor ([RAZOR-SCOPE-FORMATTING]) and nothing is advertised
- [x] Selection ranges ([RAZOR-FEATURES-SELECTION]) — `RazorSelectionRangesTests` (6 cases: C# chains through syntax nodes, tag names through enclosing elements, attribute names and values, implicit expressions, legacy files, unlisted files); `test_full_stack_razor_selection_ranges`; the routing session's `selectionRange` now asserts the exact chain. An attribute's whole span comes from the compiler's spans (a new `MarkupAttribute.End` fact), not a scan of the text
- [x] Code actions: extract a block to code-behind, extract a component, generate an event handler, add `@using` ([RAZOR-CODE-ACTIONS]) — `RazorCodeActionsTests` (5 cases). A new `@using` goes after a Razor Page's `@page` line, never above it (`A_new_import_follows_the_page_directive_a_Razor_Page_opens_with`). New files arrive as LSP `CreateFile` operations (`map_workspace_edit_creates_new_files_before_editing_them`)
- [x] Inlay hints, code lens, and call and type hierarchy from Razor positions ([RAZOR-FEATURES-INLAY-HINTS], [RAZOR-FEATURES-CODE-LENS], [RAZOR-FEATURES-HIERARCHY]) — `RazorHintsAndLensesTests` (2), `RazorHierarchyTests` (3), `test_full_stack_razor_hierarchy_and_hints`
  - Outgoing calls from a Razor projection threw: the resolver read the declaration through `Solution.GetDocument`, which is null for a source-generated document. It now reads each declaration through its own tree
  - Markup callers are the component, named by its file with kind `Class`, never the generated `BuildRenderTree`
  - The C# sidecar named hierarchy kinds in lowercase, while the host maps PascalCase (the F# sidecar's casing). So every C# class, property or interface item reached the client as a method or class. The C# kinds are now PascalCase, and the e2e asserts the LSP kinds
- [x] `.razor.css` and `.razor.js` collocation awareness ([RAZOR-COLLOCATION]) — `RazorCollocationTests` (6), `RazorStylesheetTests` (10), `HtmlMarkupContextTests` (attribute at a caret), `test_full_stack_razor_collocated_styles_and_scripts`, VS Code `a component completes and defines its stylesheet classes, and nests its collocated files`
  - Classes come from a CSS Syntax Level 3 tokenizer over rule preludes; a class completes as LSP `Value` and defines to every selector that declares it. A module literal in an `"import"` call defines to its `.razor.js`, from Razor, a code-behind and plain C#
  - The attribute at a caret is read by the HTML tokenizer, continued past the caret. Review found three bugs in a text-scanning first version: an attribute after a bare one (`<span hidden class="…">`) was read as the bare one, a caret on a name had no value, and a caret after a value still named its attribute. Each failed in `HtmlMarkupContextTests` first
  - The host mapped the `Value` kind to `Text`; it now maps to LSP `Value`
- [x] Blazor WebAssembly debugging and Razor Hot Reload ([DEBUG-FEATURES-LAUNCH-BLAZOR-WASM], [RAZOR-HOT-RELOAD])
  - WebAssembly: the `sharplsp-blazorwasm` debugger runs `dotnet run` and hands the DevServer's debug proxy to js-debug — `blazor-wasm-debug.test.ts`, `blazor-wasm-debug-resolution.test.ts`
  - Hot Reload: a Razor save swaps the additional document in every framework copy, the generator reruns and Edit and Continue emits the generated C#'s deltas — `RazorHotReloadTests` (5: markup and `@code` body edits, a mixed `.cs` and Razor batch, a signature change that demands a restart, an unlisted file named in its refusal). Each failed with the Razor branch disabled
  - A re-save of committed text answered `notCompilable`, sending the client to save again forever. Roslyn's Edit and Continue log showed the emit was Status None, nothing to apply, with no update pending. It now answers `applied` with no deltas, for `.cs` saves too (`Two_phase_updates_commit_discard_and_span_documents`)
  - VS Code: both save paths take Razor documents — `debug-hot-reload-e2e.test.ts` (a Razor save reaches the sidecar and is refused by name), `fsi-build-output-e2e.test.ts`
