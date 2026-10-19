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
- [x] Sidecar: build the Razor engine per project — configuration from the analyzer and parse options, an in-memory file system, tag helpers per compilation, the capture pass and markup facts
- [x] Sidecar: build the HTML projection and the markup-context tokenizer ([RAZOR-ARCHITECTURE-HTML])
  - [x] HTML projection from compiler IR, preserving offsets/newlines and current unsaved text — `RazorHtmlProjectionTests`: 19 passing fixture cases (Blazor and MVC, comments, UTF-16, incomplete tags, unsaved edits)
  - [x] HTML markup-context tokenizer — `HtmlMarkupContextTests`: 33 passing cases for tags, attributes, comments, quoted declarations, raw text, script escape states, malformed HTML and caret positions; 100% line coverage
  - [x] Host: `sharplsp/razor/htmlProjection` answers `{ text }`, or `null` for a file no project lists — `test_full_stack_razor_routing_session`
  - [x] Verify `sharplsp/razor/htmlProjection` through editor integration — `razor-lsp.test.ts`: the projection keeps the editor's offsets, line breaks and unsaved text, and feeds VS Code's HTML completion and hover

**Validation (2026-10-20):** the Release sidecar solution builds with zero warnings and errors; 642 C#, 440 F# and 125 Common tests pass, and all three coverage gates pass. `RazorSidecarTests` exercises the real IPC contract and malformed-request recovery; `RazorCompletionEditsTests` covers mapped edits, import deduplication, aliases, static imports and LF/CRLF insertion.

**Editor validation (2026-10-20):** the final Razor chunk passes all 5 cases, the workspace chunk passes all 446 cases (including server-start lifecycle), and editor lint and formatting pass. The debugger group-outcome test that previously timed out passes unchanged in isolation; its full chunk is being rerun before PR readiness.

### Phase 2: C# Inside Razor

- [ ] Diagnostics: C# diagnostics from projections, `RZ` diagnostics from facts, and Razor files in solution-wide diagnostics ([RAZOR-FEATURES-DIAGNOSTICS])
- [x] Hover at mapped positions ([RAZOR-FEATURES-HOVER])
- [ ] Definition, type definition, declaration and implementation from mapped positions, with generated component classes landing in their `.razor` file ([RAZOR-FEATURES-DEFINITION])
- [x] References and document highlights across projections, with hidden scaffolding dropped ([RAZOR-FEATURES-REFERENCES])
- [x] C# completion, with mapped edits and `using` → `@using` ([RAZOR-FEATURES-COMPLETION])
- [x] Signature help ([RAZOR-FEATURES-SIGNATURE-HELP])
- [x] Semantic tokens for C# fragments ([RAZOR-FEATURES-SEMANTIC-TOKENS])
- [ ] Rename and prepareRename — Razor usages and `@code` declarations, from `.cs` and `.razor` origins ([RAZOR-FEATURES-RENAME])

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
