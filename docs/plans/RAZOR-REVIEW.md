# Review since 67eba0793051391209cbfecfe3b39c2fa9c25172

Scope: the complete tracked diff from the requested baseline through current HEAD, plus in-progress working changes. Started 2026-10-20. This is a live review report; unchecked areas are still under review. Findings require concrete behavior and source evidence.

## Findings

### R1 — P1: Razor signature help exposes generated rendering calls

Owner: SharpLspCodex1. Status: fixed; all three regression cases failed for the reported reason, then passed unchanged. Razor and ordinary C# signature-help tests: 11/11 passed. The added guard has 100% line coverage and all 6/6 branch outcomes covered.

`src/sidecars/SharpLsp.Sidecar.CSharp/Workspace/SignatureHelpResolver.cs` selects an enclosing generated argument list without checking that its opening parenthesis maps to Razor source. At `disabled="@(|scores.Count > 9)"`, the user receives RenderTreeBuilder.AddAttribute signatures; `<p>@(|1)</p>` exposes AddContent. Suppress calls whose opening parenthesis has no Razor mapping, while preserving actual user C# calls. Issue: https://github.com/Nimblesite/SharpLsp/issues/400. [RAZOR-FEATURES-SIGNATURE-HELP]

### R2 — P1: completion fails immediately after a typed dot

Owner: SharpLspRazorClaude2 (fix), SharpLspCodex1 (red tests/review). Status: confirmed by real-fixture tests: implicit trailing dot and unclosed explicit expression fail with empty completions; closed explicit expression is a passing control. Fix implemented by Claude2: original resolver reproduced two failures, then all four cases passed (implicit, unclosed explicit, closed control, and unclosed code block). Full C# suite pending. Issue: https://github.com/Nimblesite/SharpLsp/issues/401

`<p>@basket.|</p>` and an unclosed `<p>@(basket.|` return no C# members. Completion works once a member prefix is present or the explicit expression is closed. The Razor generator ends or omits the mapping of these incomplete expressions. Reproduce against a real component before fixing. [RAZOR-FEATURES-COMPLETION]

### R3 — P1: newer SDK Razor generator cannot load in the sidecar

Owner: SharpLspRazorClaude2. Status: sidecar regression tests/fix in progress; SharpLspCodex1 adds host end-to-end proof and compatibility spec.

Unpinned temporary/new user projects can select SDK 10.0.401, whose Razor generator references a Roslyn version newer than the sidecar runs. The generator produces no usable component projection; Razor hover disappears and Program.cs cannot resolve generated App (CS0246). The existing fixture pin keeps ordinary regression runs deterministic but does not fix user projects. Issue: https://github.com/Nimblesite/SharpLsp/issues/399. [RAZOR-ARCHITECTURE-GENERATOR]

### R4 — P1: escaped identifiers silently receive no Razor rename edits

Owner: SharpLspCodex1. Status: fixed; the unchanged real-fixture regression now passes. Signature-help, real-call roundtrips, escaped rename, existing projection and ordinary C# signature-help tests: 29/29 passed.

`src/sidecars/SharpLsp.Sidecar.CSharp/Razor/RazorRenameEdits.cs` compared a mapped token's raw source spelling with `ISymbol.Name`. For `@class`, those are `@class` and `class`, so every declaration/use was discarded. A real-fixture test confirmed prepareRename succeeds but rename returns zero edits. The fix parses the entire mapped span as a Roslyn identifier and compares its ValueText, preserving the full replacement span. Assertions cover declaration range, placeholder, three usage/declaration edits, target path, line order, replacement text, and removal of the escape. [RAZOR-FEATURES-RENAME]. Issue: https://github.com/Nimblesite/SharpLsp/issues/402

### R5 — P1: plain C# keywords use the control-flow theme color

Owner: SharpLspCodex1. Status: editor regression reproduced red, then green unchanged.

`src/editors/vscode/package.json` mapped `controlKeyword` but omitted a language-specific plain `keyword` mapping. VS Code's public token classification registry defaults `keyword` to `keyword.control`, making `public`, `class`, `string`, and `int` purple in Dark+/Dark Modern. Add the C#-scoped standard `keyword.other.cs` mapping; retain the control keyword scope and F# grammar colors. The same mapping covers Razor and aspnetcorerazor. No RGB values or user setting overrides. The editor test asserts scope existence, language isolation, plain/control separation, and absence of hard-coded token color customization defaults. [SHARPLSP-FEATURES-HIGHLIGHTING]

### R6 — P1: F# values and functions are mislabeled as methods

Owner: SharpLspCodex1. Status: six real-project cases reproduced the incorrect categories, then passed unchanged. Full F# suite: 446/446 passed; the highlighting implementation has 100% line coverage. Value-type constructor follow-up adds a seventh red case; verification waits for the coordinated build turn.

`src/sidecars/SharpLsp.Sidecar.FSharp/FSharpFeatures.fs::mapFcsSymbolKind` reports every non-property/event function-or-value as method. Module values and local values therefore receive method colors, and functions lose their standard function category. FCS property/qualified ranges can also include receivers. Tests pin exact spans and standard categories for module/local values, functions, properties and methods in both full and range results, and assert keywords remain owned by the grammar. Reuse the existing FCS lexer helper for source token boundaries. [SHARPLSP-FEATURES-HIGHLIGHTING]

### R7 — P2: non-finite video seek parameters throw in the page

Owner: SharpLspRazorClaude1. Status: fixed and pushed as b7d301d8; regression failed with a non-finite currentTime page error, then passed across all three browser/form-factor projects.

`src/website/src/assets/js/custom.js::initSeekToTime` accepted `?t=Infinity` because Infinity is positive, then assigned an invalid media currentTime. Guard with Number.isFinite. The new test also checks overflowing `1e400`, negative and nonnumeric inputs and asserts no page error or seek. [WEB-DESIGN-MEDIA-DISCOVERY]

## Review and validation checklist

- [x] C# workspace/query changes and non-Razor compatibility reviewed
- [x] Razor compiler/IR/mapping/HTML/rename/structure reviewed
- [x] Common paths and F# project loading reviewed
- [x] Rust host routing/syntax/diagnostics/sort changes reviewed
- [x] VS Code and Zed integration reviewed
- [x] Website templates/data/media/tooling and documentation reviewed
- [x] Changed existing tests audited for removed/weakened assertions
- [x] lspkit submodule changes reviewed: only `.deslop/` added to its `.gitignore`; no runtime code changed.
- [x] R1 reproduced red, fixed, unchanged tests green
- [x] R2 reproduced red, fixed, unchanged tests green (Claude2 reports 4/4; integration suite pending)
- [ ] R3 newest-SDK host regression proof green after sidecar fix
- [x] R4 escaped rename fixed with unchanged real-fixture assertions (29-test focused run green)
- [x] R5 standard keyword scope regression red/green in the real editor
- [x] R6 F# category/span/operator regressions red/green (446-test full suite green)
- [x] R7 non-finite video seek regression red/green across three projects
- [ ] Value-type constructor follow-up green on final F# build
- [ ] Full integrated suite and CI gates green

Pi performed the SDK test reuse inspection, which was reviewed against the source and used. The subsequent read-only website/host/Razor/F# review requests all returned provider timeouts without findings. The primary agent inspected those changes directly; no review item relies on missing delegation output.

## Test weakening audit evidence

- Removed assertion lines in the existing test diff occur in the website media tests: the 2400px/loaded/meaningful-alt/no-filename checks moved unchanged into `tests/media.js::expectStills` and remain called.
- Existing video catalogue expectations changed to the replacement narrated films and MP4-first encoding; equivalent schema/source/poster checks remain, with all-language walkthrough coverage added.
- Zed assertions retain the existing CSharp/FSharp values and add Razor; the unavailable-sidecar assertion still requires an error after its handler rename.
- No existing C#/F# sidecar assertions were removed. C# coverage threshold increased from 95 to 95.39; no threshold was lowered.
- SDK pinning narrowed the ordinary Razor fixtures' SDK selection. A separate unpinned Rust regression test now restores the newest installed SDK and asserts a real C# field hover, mapped range, and no generated-component CS0246. It compiles; execution awaits the #399 sidecar fix.

## Static scope and excluded candidates

The baseline diff initially covered 395 tracked paths: 276 website, 58 sidecar, 41 host, 11 editor, plus documentation/configuration/submodule paths. The continuing working changes and follow-up commits are included. Runtime review traced projection ownership and UTF-16 mapping, generated-location filtering, real-file edits/import insertion, active frameworks, F# references, host dispatch, virtual HTML document lifetime, middleware request ordering, standard theme fallback, template escaping, catalogue-generated pages, captions, video source selection, and filming tool isolation. Media binaries were reviewed through references/metadata and existing browser assertions, not by treating binary bytes as source code.

A possible open-sync composition race was rejected after tracing the actual hooks: open-sync intercepts sendRequest, while Razor wraps provideHover/provideCompletionItem, so their middleware keys do not overwrite each other. No patch or assertion removal was made for that rejected candidate.

Remaining unchecked validation tasks concern executing fixes together and CI; they are not a claim that later Razor backlog phases are complete.
