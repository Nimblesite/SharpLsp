# XAML Implementation Plan: .NET MAUI, WPF, Avalonia, WinUI and Uno

**Spec:** [XAML-SPEC.md](../specs/XAML-SPEC.md)

## Context

SharpLsp has no XAML support today: `LangId` is C#, F# and Razor, and no source file mentions XAML. This plan adds a single XAML engine for every dialect, in every editor, on every OS. The evidence below decides what ships first.

### Evidence: what people search for

Google Trends related queries, worldwide, past 12 months, to 2026-11-01.

| Search | Seed | Top related queries | Rising |
|---|---|---|---|
| Web | xaml | **wpf** (100), xaml wpf (98), xaml c# (29), **maui** (29), what is xaml (24), visual studio (24), **xaml binding** (20), avalonia (16), **xaml designer** (15), .net maui (14) | visual studio 2026 (+2,600%), xaml islands (+500%), **xaml hot reload (+90%)**, **avalonia (+60%)**, **winui (+50%)** |
| YouTube | xaml | wpf xaml (100), wpf (97), **xaml tutorial** (83), xaml c# (81), xaml file (54), xaml studio (43), **xaml designer** (23), .net maui (16) | **xaml designer (+40%)** |
| Web | xaml designer | visual studio xaml designer (100), **visual studio xaml designer not showing** (5) | none |
| Web | .net maui | .net maui documentation (100), what is .net maui (73), .net maui github (38), **.net maui blazor** (37), xaml (26), **.net maui linux** (20) | .net maui documentation (+450%), what is .net maui (+140%), **.net maui linux (+50%)** |
| YouTube | .net maui | **.net maui tutorial** (100), .net maui blazor (73), .net maui vs flutter (8) | none |
| Web | wpf | microsoft wpf (100), **c# wpf** (89), what is wpf (62), .net wpf (53), wpf app (47), xaml (40), wpf ui (31), devexpress wpf (26) | (German diet-plan noise) |
| YouTube | wpf | wpf c# (100), wpf tutorial (51), wpf c# tutorial (33), **wpf mvvm** (29), wpf ui (19), wpf design (14), visual studio wpf (12) | none |
| Web | avalonia | avalonia ui (100), avalonia github (59), avalonia c# (28), **avalonia 12** (24), wpf (19), xaml (18), maui (12), avalonia datagrid (10) | **avalonia 12 (+300%)**, avalonia github (+250%) |
| Web | winui | windows app sdk (100), wpf (76), winui desktop (74), winui github (55), xaml (54), maui (36), winui vs wpf (25) | windows app sdk (+120%), winui desktop (+110%) |
| Web | mvvm | wpf (100), mvvm architecture (100), mvvm wpf (97), c# mvvm (38), **mvvm toolkit** (24) | what is mvvm (+90%) |

Interest over five years (relative, average): xaml 54, .net maui 47, winui 19, uno platform 9, avalonia ui 5. "maui" alone is swamped by Hawaii; "xaml hot reload", "maui hot reload", "maui vs code", "uno platform", "xaml binding" and "wpf vs code" are below Trends' reporting threshold.

What the data says:

- **WPF is the biggest XAML audience, and C# Dev Kit gives it nothing.** "wpf" leads every XAML query. VS Code has no WPF XAML language support from Microsoft ([vscode-dotnettools #1789](https://github.com/microsoft/vscode-dotnettools/issues/1789), open; [dotnet/wpf #280](https://github.com/dotnet/wpf/issues/280)).
- **The designer and hot reload are what people look for and can't get.** "xaml designer" is rising on YouTube, "visual studio xaml designer not showing" is a recurring web query, and "xaml hot reload" is up 90%.
- **Avalonia and WinUI are growing.** Avalonia is up 60%, Avalonia 12 is up 300%, and WinUI is up 50%.
- **Binding and MVVM are the daily work.** "xaml binding", "wpf mvvm" and "mvvm toolkit" all show up.
- **People want MAUI and XAML off Windows.** ".net maui linux" is rising.

### Evidence: pain points

Reddit blocks automated readers, so these come from sources that can be read and counted: GitHub issues ranked by reactions, and Hacker News comments.

| Pain | Evidence |
|---|---|
| No MAUI designer or previewer | [dotnet/maui #3439](https://github.com/dotnet/maui/issues/3439) "WinForms-like designer with optional hot reload XAML window": **379 reactions, 104 comments**, the most-reacted XAML tooling issue in the repo. [#6782](https://github.com/dotnet/maui/issues/6782) XAML designer/previewer. The last Xamarin.Forms previewer code path was removed in 2026 ([#37065](https://github.com/dotnet/maui/issues/37065)). |
| Hot reload breaks | [vscode-dotnettools #867](https://github.com/microsoft/vscode-dotnettools/issues/867) hot reload for MAUI iOS and Android (open, 18 reactions). [#3197](https://github.com/microsoft/vscode-dotnettools/issues/3197) XAML Hot Reload broken on macOS while C# works (open, 2026-06). [dotnet/maui #35787](https://github.com/dotnet/maui/issues/35787) "XAML Hot reload completely broken". [Avalonia #3266](https://github.com/AvaloniaUI/Avalonia/issues/3266) XAML hot reload (open since 2019, 33 reactions). A 2025 MAUI discussion calls the tooling "still an awful experience, either using Rider, or Visual Studio", citing hot reload stopping and the clean-bin-obj ritual ([dotnet/maui #27185](https://github.com/dotnet/maui/discussions/27185)). |
| XAML IntelliSense missing or flaky outside Visual Studio | [vscode-dotnettools #1082](https://github.com/microsoft/vscode-dotnettools/issues/1082) and [#1292](https://github.com/microsoft/vscode-dotnettools/issues/1292) MAUI XAML IntelliSense not working. [#565](https://github.com/microsoft/vscode-dotnettools/issues/565) better MAUI XAML IntelliSense. [#3093](https://github.com/microsoft/vscode-dotnettools/issues/3093) WinUI errors not shown in Problems (open). [Avalonia #999](https://github.com/AvaloniaUI/Avalonia/issues/999) (66 reactions) and [#1587](https://github.com/AvaloniaUI/Avalonia/issues/1587) (47) ask for VS Code support. |
| C# Dev Kit only, and it is fragile | Microsoft's MAUI extension needs C# Dev Kit and its licence. [vscode-dotnettools #799](https://github.com/microsoft/vscode-dotnettools/issues/799) "C# Dev Kit completely broken. Nothing works." (139 comments). [#1909](https://github.com/microsoft/vscode-dotnettools/issues/1909) "Did you just ban Cursor?" (80 reactions). |
| Solution Explorer removed from C# Dev Kit | [vscode-dotnettools #3067](https://github.com/microsoft/vscode-dotnettools/issues/3067) "Go back to C# SOLUTION EXPLORER" (**252 reactions, 156 comments**), [#3085](https://github.com/microsoft/vscode-dotnettools/issues/3085) (42), [#3083](https://github.com/microsoft/vscode-dotnettools/issues/3083) (62). |
| Binding errors found only at runtime | [dotnet/maui #4818](https://github.com/dotnet/maui/issues/4818) "No DataContext found for Binding". [#33693](https://github.com/dotnet/maui/issues/33693) XAML C# expressions (117 reactions) shows the demand for typed, checked bindings. |
| No visual tree inspector in VS Code | [vscode-dotnettools #1853](https://github.com/microsoft/vscode-dotnettools/issues/1853) Maui Visual Tree Inspector for VS Code (open). |
| F# is shut out of XAML | [dotnet/wpf #162](https://github.com/dotnet/wpf/issues/162) Add F# support for WPF (open, 72 reactions). |
| Cross-platform | [dotnet/maui #11738](https://github.com/dotnet/maui/issues/11738) Blazor Hybrid on Linux (open, 174 reactions). [dotnet/wpf #48](https://github.com/dotnet/wpf/issues/48) make WPF cross-platform (903 reactions). |

Hacker News says the same: MAUI was "really, really rough" for basic things ([45894712](https://news.ycombinator.com/item?id=45894712)); a dev who likes XAML still found the development loop the weak spot ([45483618](https://news.ycombinator.com/item?id=45483618)); and one dev chose Avalonia because it has a XAML previewer in VS Code ([39246338](https://news.ycombinator.com/item?id=39246338)).

### Where the gap is

| | Visual Studio 2026 | Rider | C# Dev Kit + MAUI ext. | **SharpLsp** |
|---|---|---|---|---|
| Price | Licence above the Community tier | Paid for commercial use | Dev Kit licence | Free, MIT |
| Editors | Visual Studio only | Rider only | VS Code only (not Cursor and other forks) | VS Code, VSCodium, Cursor, Windsurf, Zed, any LSP client |
| OS | Windows | Windows, macOS, Linux | Windows, macOS, Linux | Windows, macOS, Linux |
| MAUI XAML | ✓ | ✓ | ✓ (preview flag) | ✓ |
| WPF XAML | ✓, Windows only | ✓ | ✗ | ✓ on every OS ([XAML-SCOPE-ANYWHERE]) |
| Avalonia XAML | Extension | Plugin | ✗ | ✓ |
| WinUI / Uno XAML | ✓ / extension | ✓ | ✗ | ✓ |
| F# view models and code-behind | Partial | Partial | ✗ | ✓ first-class ([XAML-FSHARP]) |
| Typed binding checks before build | Partial | ✓ | Partial | ✓ every dialect |
| MAUI previewer | ✗ | ✗ | ✗ | Running-app preview ([XAML-PREVIEW-RUNNING-APP]) |
| Solution Explorer with nesting | ✓ | ✓ | Removed | ✓ |

The void: **WPF, Avalonia, WinUI and F# XAML outside Visual Studio and Rider, free, in every editor**, plus a MAUI preview that nobody ships.

## Phasing

Order follows the evidence: audience size (WPF, MAUI), then growth (Avalonia, WinUI), then the loop people complain about most (hot reload, preview).

- **Phase 0: research spikes.** Close the open items in [XAML-RESEARCH] before Phase 3 and Phase 4 design is final.
- **Phase 1: the engine, for WPF, MAUI and Avalonia, in C# and F#.** Routing, parser, binder, type sources, diagnostics, completion, hover, definition, references, rename, structure, nesting.
- **Phase 2: WinUI 3 and Uno.** `using:` namespaces and `x:Bind`.
- **Phase 3: code actions and editing polish.** Add xmlns, generate handler, add `x:DataType`, extract to resource, new XAML file, colors, inlay hints.
- **Phase 4: hot reload.** MAUI source-generated XAML first, then the runtime agent.
- **Phase 5: preview.** Avalonia previewer webview, then running-app preview and the visual tree.

## TODO

### [XAML-PLAN-RESEARCH] Phase 0: Research

- [ ] Confirm whether MAUI 10's XAML source generator emits `#line` mappings to the XAML file, and whether Edit and Continue applies its regenerated C# ([XAML-RESEARCH] item 5)
- [ ] Find which dialects `dotnet watch` reloads XAML for, and which public APIs a runtime XAML reload can use per dialect ([XAML-RESEARCH] item 6)
- [ ] Confirm `Avalonia.Remote.Protocol` message set and previewer host launch for Avalonia 12
- [ ] Confirm WPF and WinUI projects load in `MSBuildWorkspace` on macOS and Linux with `EnableWindowsTargeting=true`, and that the Windows Desktop reference assemblies resolve
- [ ] Measure `GuiLabs.Language.Xml` on malformed input (unclosed tags, half-typed attributes) and on a 5,000-line resource dictionary
- [ ] Pick the tree-sitter XML grammar and confirm it builds in the host with the existing grammars
- [ ] Record the findings in [XAML-RESEARCH] and drop the **open** markers

### Phase 1: Engine (WPF, MAUI, Avalonia; C# and F#)

- [ ] `LangId::Xaml` for `.xaml` and `.axaml`, routed to the owning project's sidecar ([XAML-ARCHITECTURE-ROUTING])
- [ ] Host syntax features from tree-sitter XML: document symbols, folding, selection range, linked editing ([XAML-FEATURES-STRUCTURE])
- [ ] XAML documents as additional documents in each owning project and framework context, with replay of pre-load edits
- [ ] Binder in `SharpLsp.Sidecar.Common`: parse, `xmlns` resolution, element, member and markup-extension binding ([XAML-ARCHITECTURE-FACTS])
- [ ] Type-source abstraction, with the Roslyn type source in the C# sidecar ([XAML-ARCHITECTURE-TYPES])
- [ ] FCS type source in the F# sidecar, in the same release ([XAML-FSHARP])
- [ ] Dialect tables for MAUI, WPF and Avalonia: property conventions, namespaces, typed bindings, Avalonia selectors ([XAML-DIALECTS])
- [ ] Resource scope resolution ([XAML-ARCHITECTURE-RESOURCES])
- [ ] Diagnostics `XAML0001` to `XAML0010`, honouring [DIAG-TRUTH] ([XAML-FEATURES-DIAGNOSTICS])
- [ ] Build-error mapping for XamlC, MC and AVLN codes
- [ ] Completion ([XAML-FEATURES-COMPLETION])
- [ ] Hover ([XAML-FEATURES-HOVER])
- [ ] Definition, including `x:Name` from code-behind ([XAML-FEATURES-DEFINITION])
- [ ] References and highlights, including from C# and F# into XAML ([XAML-FEATURES-REFERENCES])
- [ ] Rename across XAML, C# and F# ([XAML-FEATURES-RENAME])
- [ ] Semantic tokens ([XAML-FEATURES-SEMANTIC-TOKENS])
- [ ] Solution Explorer and Explorer nesting of code-behind ([XAML-SOLUTION-EXPLORER])
- [ ] VS Code: `xaml` and `axaml` document sync and activation; Zed language attachment ([XAML-EDITORS])
- [ ] Fixture solution `XamlFixtures.slnx` with `MauiApp`, `WpfApp`, `AvaloniaApp`, `AvaloniaFs` and `ViewModels` ([XAML-TESTING])
- [ ] Rust e2e: long sessions per dialect, covering open, edit, diagnostics, completion, hover, definition, references and rename, with many assertions per step
- [ ] VS Code e2e `xaml` chunk, desktop and Windows legs
- [ ] Website docs page for XAML (prose classes) and a release note

### Phase 2: WinUI 3 and Uno

- [ ] `using:` namespaces and platform XML namespaces ([XAML-DIALECTS])
- [ ] `x:Bind` paths as member access on the page class, with method calls and signature help
- [ ] WMC build-error mapping
- [ ] Fixture `WinUIApp` and e2e coverage

### Phase 3: Code actions and polish

- [ ] Add xmlns, including the project reference case ([XAML-CODE-ACTIONS-XMLNS])
- [ ] Generate event handler in C# and F# ([XAML-CODE-ACTIONS-HANDLER])
- [ ] Add `x:DataType` ([XAML-CODE-ACTIONS-DATATYPE])
- [ ] Extract to resource ([XAML-CODE-ACTIONS-RESOURCE])
- [ ] New XAML file from the Solution Explorer ([XAML-CODE-ACTIONS-NEW-FILE])
- [ ] Document colors ([XAML-FEATURES-COLOR])
- [ ] Inlay hints on typed bindings ([XAML-FEATURES-INLAY-HINTS])

### Phase 4: Hot reload

- [ ] MAUI source-generated XAML through Edit and Continue, if Phase 0 confirms it ([XAML-HOT-RELOAD])
- [ ] Runtime reload agent per dialect, through public APIs only
- [ ] Binder errors block a reload and show why; failures are never silent
- [ ] VS Code e2e: edit XAML in a running debug session and assert the change applied

### Phase 5: Preview

- [ ] Avalonia preview webview over `Avalonia.Remote.Protocol` ([XAML-PREVIEW-AVALONIA])
- [ ] Running-app preview for MAUI, WPF, WinUI and Uno desktop targets ([XAML-PREVIEW-RUNNING-APP])
- [ ] Visual tree view with select-to-reveal in XAML

### Launch

- [ ] YouTube: one film per dialect, with titles and descriptions drawn from the Trends queries above (docs/branding/youtube)
- [ ] Close the related SharpLsp issues only after testing a published release
