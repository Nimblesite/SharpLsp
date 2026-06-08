# C# Dev Kit Parity Plan

Gap analysis and implementation roadmap to reach feature parity with C# Dev Kit, then surpass it.

## Gap Analysis: SharpLsp vs C# Dev Kit

### Legend
- **DONE** = SharpLsp has this fully working
- **PARTIAL** = SharpLsp has some support but incomplete
- **MISSING** = SharpLsp doesn't have this at all
- **AHEAD** = SharpLsp already goes past C# Dev Kit here

---

### Solution Explorer / Project Management

| Feature | C# Dev Kit | SharpLsp | Status |
|---------|-----------|-------|--------|
| Solution tree view | Yes | Yes | **DONE** |
| Auto-detect .sln files | Yes | Yes | **DONE** |
| Multi-solution prompt | Yes | Yes (selectSolution) | **DONE** |
| Close/Open Solution commands | Yes | Partial (select only) | **PARTIAL** |
| Solution Folders display | Yes | No | **MISSING** |
| Add New Project to solution | Yes | No | **MISSING** |
| Add New File to project | Yes | No | **MISSING** |
| Project templates (console, web, class lib) | Yes | No | **MISSING** |
| View/edit .csproj from tree | Yes | No | **MISSING** |
| Build/Rebuild/Clean from context menu | Yes | No | **MISSING** |
| Dependencies folder | Yes | Yes | **DONE** |
| NuGet package display with versions | Yes | Yes | **DONE** |
| Project reference display | Yes | Yes | **DONE** |
| Remove NuGet package | No (read-only) | Yes | **AHEAD** |
| Remove project reference | No (read-only) | Yes | **AHEAD** |
| Namespace merging in explorer | No | Yes | **AHEAD** |
| Member-level symbols in explorer | No | Yes | **AHEAD** |
| Sort modes (natural/alpha/accessibility) | No | Yes | **AHEAD** |
| F# project support | No | Yes | **AHEAD** |

### Code Intelligence

| Feature | C# Dev Kit | SharpLsp | Status |
|---------|-----------|-------|--------|
| Auto-completion | Yes | Yes | **DONE** |
| Completion resolve | Yes | Yes | **DONE** |
| Import suggestions in completion | Yes | No | **MISSING** |
| Snippet completion | Yes | No | **MISSING** |
| Hover / Quick Info | Yes | Yes | **DONE** |
| Signature help | Yes | No | **MISSING** |
| Inlay hints (parameter names) | Yes | Yes | **DONE** |
| Inlay hints (type inference) | Yes | Yes | **DONE** |
| Semantic highlighting | Yes | Yes | **DONE** |
| Code snippets | Yes | No | **MISSING** |
| Background code analysis | Yes (configurable) | Yes | **DONE** |

### Code Navigation

| Feature | C# Dev Kit | SharpLsp | Status |
|---------|-----------|-------|--------|
| Go to definition | Yes | Yes | **DONE** |
| Go to declaration | Yes | Yes | **DONE** |
| Go to type definition | Yes | Yes | **DONE** |
| Go to implementation | Yes | Yes | **DONE** |
| Find all references | Yes | Yes | **DONE** |
| Document highlights | Yes | Yes | **DONE** |
| Peek Definition (inline) | Yes | Yes (editor feature) | **DONE** |
| Workspace symbol search | Yes | Yes | **DONE** |
| Breadcrumbs | Yes | No | **MISSING** |
| Call hierarchy | No | Yes | **AHEAD** |
| Type hierarchy | No | Yes | **AHEAD** |

### Code Actions & Refactorings

| Feature | C# Dev Kit | SharpLsp | Status |
|---------|-----------|-------|--------|
| Add missing usings | Yes | Yes | **DONE** |
| Organize usings | Yes | Yes | **DONE** |
| Extract method | Yes | Yes | **DONE** |
| Extract variable | Yes | Yes | **DONE** |
| Inline variable/method | Yes | Yes | **DONE** |
| Move type to file | Yes | Yes | **DONE** |
| Generate constructor | Yes | Yes | **DONE** |
| Generate interface impl | Yes | Yes | **DONE** |
| Implement interface (explicit/implicit) | Yes | Yes | **DONE** |
| Convert class to record | Yes | Yes | **DONE** |
| Convert between string forms | Yes | Yes | **DONE** |
| Encapsulate field | Yes | Yes | **DONE** |
| Use var / explicit type | Yes | Yes | **DONE** |
| Rename symbol (all code elements) | Yes | No | **MISSING** |
| Sort members | No | Yes | **AHEAD** |
| All Roslyn quick fixes | Yes | Yes | **DONE** |
| All Roslyn refactorings | Yes | Yes | **DONE** |

### Formatting

| Feature | C# Dev Kit | SharpLsp | Status |
|---------|-----------|-------|--------|
| Document formatting | Yes | Disabled (prefer CSharpier/Fantomas) | **PARTIAL** |
| Range formatting | Yes | Disabled (prefer CSharpier/Fantomas) | **PARTIAL** |
| On-type formatting | Yes | Disabled (prefer CSharpier/Fantomas) | **PARTIAL** |
| Format on save | Yes | No | **MISSING** |
| EditorConfig support | Yes | Partial (diagnostics only) | **PARTIAL** |

### Diagnostics

| Feature | C# Dev Kit | SharpLsp | Status |
|---------|-----------|-------|--------|
| Compiler diagnostics (per-document pull) | Yes | Yes | **DONE** |
| LSP 3.17 pull diagnostics (`textDocument/diagnostic`) | Yes | Yes (handlers wired; `previousResultId`/`unchanged` reporting in [DIAGNOSTICS-PLAN Phase 5](DIAGNOSTICS-PLAN.md#phase-5-pull-diagnostics--refresh-cycle-p0--primary-path)) | **PARTIAL** |
| Workspace pull diagnostics (`workspace/diagnostic`) | Yes (server side; UX gap in CDK extension) | Yes (server + extension surfaces in Problems panel) | **PARTIAL** |
| `workspace/diagnostic/refresh` (debounced workspace event → editor re-pull) | Yes (2000ms `AsyncBatchingWorkQueue`) | In [Phase 5](DIAGNOSTICS-PLAN.md#phase-5-pull-diagnostics--refresh-cycle-p0--primary-path) (matches Roslyn LSP 2000ms debounce) | **MISSING** |
| NuGet restore gate before workspace open | Yes (`ProjectDependencyHelper`) | In [Phase 5.6](DIAGNOSTICS-PLAN.md#phase-56-nuget-restore-gate-p0); critical for eliminating phantom CS0246 | **MISSING** |
| `workspace/projectInitializationComplete` notification | Yes | In [Phase 5.6](DIAGNOSTICS-PLAN.md#phase-56-nuget-restore-gate-p0) | **MISSING** |
| Solution-wide analysis surfaced in Problems panel without opening files | UX gap (server supports it; extension doesn't drive the pull) | Yes (SharpLsp VS Code extension drives `workspace/diagnostic` pull) | **DIFFERENTIATOR** |
| No phantom CS0246 during workspace load | Yes (because pull-only + restore gate) | Yes (after [Phase 5](DIAGNOSTICS-PLAN.md#phase-5-pull-diagnostics--refresh-cycle-p0--primary-path) + [5.6](DIAGNOSTICS-PLAN.md#phase-56-nuget-restore-gate-p0); previous push+verification model removed because it lied) | **IN PROGRESS** |
| Roslyn analyzer diagnostics | Yes | Partial | **PARTIAL** |
| EditorConfig diagnostic config | Yes | Partial | **PARTIAL** |

### Test Explorer

| Feature | C# Dev Kit | SharpLsp | Status |
|---------|-----------|-------|--------|
| Test discovery (xUnit, NUnit, MSTest) | Yes | No | **MISSING** |
| Run tests from editor | Yes | No | **MISSING** |
| Run tests from Test Explorer | Yes | No | **MISSING** |
| Debug tests | Yes | No | **MISSING** |
| Code coverage visualization | Yes | No | **MISSING** |
| Test result display | Yes | No | **MISSING** |
| bUnit support | Yes | No | **MISSING** |

### Debugging

| Feature | C# Dev Kit | SharpLsp | Status |
|---------|-----------|-------|--------|
| F5 launch with auto-config | Yes | No | **MISSING** |
| Dynamic launch configs | Yes | No | **MISSING** |
| Attach to process | Yes | No | **MISSING** |
| Conditional breakpoints | Yes | No | **MISSING** |
| Function breakpoints | Yes | No | **MISSING** |
| Logpoints | Yes | No | **MISSING** |
| Exception handling config | Yes | No | **MISSING** |
| Watch expressions | Yes | No | **MISSING** |
| Just My Code | Yes | No | **MISSING** |
| launchSettings.json integration | Yes | No | **MISSING** |
| Hot Reload | Yes | No | **MISSING** |

### NuGet Package Management

See [NUGET-BROWSER-SPEC.md](../specs/NUGET-BROWSER-SPEC.md) and [NUGET-BROWSER-PLAN.md](NUGET-BROWSER-PLAN.md) for full details.

All NuGet operations route through LSP custom requests (`sharplsp/nuget/*`). The extension is a thin UI shell only.

| Feature | C# Dev Kit | SharpLsp | Status |
|---------|-----------|-------|--------|
| Search & add packages | Yes | Partial (UI exists, needs LSP backend) | **IN PROGRESS** |
| Update packages | Yes | Partial (UI exists, needs LSP backend) | **IN PROGRESS** |
| Remove packages | Yes | Partial (UI exists, needs LSP backend) | **IN PROGRESS** |
| NuGet browser webview | No | Yes (needs design fixes) | **IN PROGRESS** |
| Auto-restore on load/build | Yes | No | **MISSING** |
| Prerelease toggle | Yes | No | **MISSING** |

### Project Scaffolding

| Feature | C# Dev Kit | SharpLsp | Status |
|---------|-----------|-------|--------|
| New Project from template | Yes | No | **MISSING** |
| New File from template (class, interface, etc.) | Yes | No | **MISSING** |

### Features Where SharpLsp is Already Ahead

| Feature | Notes |
|---------|-------|
| F# as first-class citizen | C# Dev Kit has zero F# support |
| Solution Explorer depth | SharpLsp shows namespaces, types, members; Dev Kit shows only files |
| Remove NuGet/project refs | Dev Kit tree is read-only |
| Sort members command | Not available in Dev Kit |
| .NET Profiler integration | Full EventPipe, counters, heap analysis -- Dev Kit has nothing |
| Copy qualified name | Context menu feature Dev Kit lacks |
| Open source, no license | Dev Kit requires VS subscription for organizations |
| Editor-agnostic | Dev Kit is VS Code only |

---

## Implementation Plan

### Priority 1 -- Critical Parity (Weeks 1-6)

These are the features users hit within the first 5 minutes. Without them, SharpLsp feels broken.

- [x] **P1.1: Code Actions & Quick Fixes**
  - [x] Wire up Roslyn `CodeFixProvider` pipeline through sidecar IPC
  - [x] Wire up Roslyn `CodeRefactoringProvider` pipeline through sidecar IPC
  - [x] Implement `textDocument/codeAction` handler in Rust host (`code_actions.rs`)
  - [x] Implement `codeAction/resolve` for deferred workspace edits
  - [x] Add missing usings / organize usings (single most-used code action)
  - [x] Generate constructor, implement interface, generate overrides
  - [x] Extract method, extract variable, inline variable
  - [x] All remaining Roslyn built-in code fixes (expose full set)
  - [x] All remaining Roslyn built-in refactorings (expose full set)
  - [x] F# code fixes via FCS

- [x] **P1.2: Formatting** (code exists but intentionally disabled — prefer CSharpier/Fantomas)
  - [x] Implement `textDocument/formatting` via Roslyn Formatter (C#) — behind `#[cfg(feature = "formatting")]`
  - [x] Implement `textDocument/formatting` via Fantomas (F#) — behind `#[cfg(feature = "formatting")]`
  - [x] Implement `textDocument/rangeFormatting` — behind `#[cfg(feature = "formatting")]`
  - [x] Implement `textDocument/onTypeFormatting` — behind `#[cfg(feature = "formatting")]`
  - [ ] EditorConfig full integration for formatting rules
  - [ ] Wire up format-on-save in VS Code extension settings

- [x] **P1.3: Semantic Highlighting**
  - [x] Implement `textDocument/semanticTokens/full` via Roslyn classifier (C#) — `semantic_tokens.rs`
  - [x] Implement `textDocument/semanticTokens/full` via FCS (F#)
  - [x] Implement `textDocument/semanticTokens/range` for visible range optimization
  - [x] Implement `textDocument/semanticTokens/full/delta` for incremental updates
  - [x] Register token types and modifiers in server capabilities

- [x] **P1.4: Inlay Hints**
  - [x] Implement `textDocument/inlayHint` handler — `inlay_hints.rs`
  - [x] Parameter name hints (C# + F#)
  - [x] Type inference hints for `var` and lambdas (C#)
  - [x] Type inference hints for let bindings (F#)
  - [ ] Pipeline type hints (F#)
  - [ ] Add VS Code settings to toggle each hint category

- [x] **P1.5: Import Suggestions in Completion** (handled via code actions — add missing usings)
  - [x] Enable Roslyn import completion provider
  - [x] Auto-add using directive on completion commit
  - [x] Show unimported type completions with (import) label

- [ ] **P1.6: Rename Symbol (P0 parity blocker)** — see [RENAME-SPEC.md](../specs/RENAME-SPEC.md)
  - [ ] `textDocument/prepareRename` and `textDocument/rename`
  - [ ] C# Roslyn `Renamer.RenameSymbolAsync`
  - [ ] F# compiler-service rename/symbol-use pipeline
  - [ ] WorkspaceEdit conversion and cancellation
  - [ ] Full code-element coverage: types, enums, enum members, methods/functions, constructors, properties/indexers, fields/events, variables, parameters, namespaces/modules, generic parameters, aliases, F# record fields, F# DU cases, and F# active patterns
  - [ ] Coarse e2e coverage for every code-element category

### Priority 2 -- Essential Features (Weeks 7-14)

Features users expect within the first day of use.

- [ ] **P2.1: Debugging (DAP Integration)**
  - [ ] Integrate netcoredbg as debug adapter
  - [ ] Auto-generate launch configurations from .csproj discovery
  - [ ] Launch .NET process with F5 (no manual launch.json required)
  - [ ] Attach to running .NET process
  - [ ] Line breakpoints, conditional breakpoints, logpoints
  - [ ] Step in/over/out, continue
  - [ ] Variable inspection, watch expressions
  - [ ] Call stack navigation
  - [ ] Exception breakpoints (all, user-unhandled, filtered)
  - [ ] Just My Code support
  - [ ] launchSettings.json profile integration
  - [ ] Debug toolbar integration
  - [ ] F# debugging support (same adapter)

- [ ] **P2.2: Test Explorer**
  - [ ] Test discovery via `dotnet test --list-tests` or Roslyn test symbol detection
  - [ ] VS Code Test Controller API integration
  - [ ] xUnit test discovery and execution
  - [ ] NUnit test discovery and execution
  - [ ] MSTest test discovery and execution
  - [ ] Run individual test, test class, test namespace
  - [ ] Debug individual test
  - [ ] Test result display (pass/fail/skip with duration)
  - [ ] Editor decorations (green play button, red/green indicators)
  - [ ] F# test framework support (Expecto, FsCheck)
  - [ ] Code coverage integration (optional)

- [ ] **P2.3: Build Integration**
  - [ ] Build command (`dotnet build`) from Command Palette
  - [ ] Build/Rebuild/Clean from Solution Explorer context menu
  - [ ] Build errors routed to diagnostics
  - [ ] Auto-build on test discovery refresh
  - [ ] Build task provider for tasks.json integration

- [x] **P2.4: NuGet Package Management** — see [NUGET-BROWSER-PLAN.md](NUGET-BROWSER-PLAN.md) (core complete)
  - [x] Implement `sharplsp/nuget/search` LSP handler (Rust host)
  - [x] Implement `sharplsp/nuget/versions` LSP handler (Rust host)
  - [x] Implement `sharplsp/nuget/installed` LSP handler (Rust host)
  - [x] Implement `sharplsp/nuget/install` LSP handler (Rust host, XML fast-path)
  - [x] Implement `sharplsp/nuget/uninstall` LSP handler (Rust host, XML fast-path)
  - [x] Refactor extension NuGet browser to use LSP requests (remove direct CLI/HTTP)
  - [x] Fix NuGet browser UI to match design spec (Material icons, no emoji, no duplicate settings)
  - [x] Add Dependencies section to details panel
  - [x] Add automated VSIX tests for NuGet browser
  - [x] Add E2E Rust tests for all sharplsp/nuget/* handlers
  - [ ] Prerelease version toggle
  - [ ] NuGet restore command
  - [ ] Auto-restore on project load

### Priority 3 -- Quality of Life (Weeks 15-20)

Features that make the daily experience smooth.

- [ ] **P3.1: Project Scaffolding**
  - [ ] "SharpLsp: New Project" command using `dotnet new` templates
  - [ ] Template selection quick pick (console, web, classlib, test, etc.)
  - [ ] "SharpLsp: New File" command (class, interface, enum, struct, record)
  - [ ] Auto-add file to project
  - [ ] "SharpLsp: Add Project to Solution" command

- [ ] **P3.2: Hot Reload**
  - [ ] Integrate `dotnet watch` for hot reload during debug
  - [ ] Hot Reload button in debug toolbar
  - [ ] Hot Reload on save setting
  - [ ] Status bar indicator for hot reload state

- [ ] **P3.3: Solution Explorer Enhancements**
  - [ ] Solution Folders display and management
  - [ ] Open .csproj/.fsproj from project node
  - [ ] Add existing project to solution
  - [ ] Add project reference via UI
  - [ ] Add NuGet package from explorer context menu

- [x] **P3.4: Workspace Symbol Search**
  - [x] Implement standard `workspace/symbol` LSP method — `workspace_symbols.rs`
  - [x] Fuzzy matching across solution
  - [x] Symbol kind filtering

- [x] **P3.5: Code Lens** — `code_lens.rs`
  - [x] Reference count lens above types and members
  - [x] Implementation count lens above interfaces/abstract classes
  - [ ] Test status lens (pass/fail indicator above test methods)

### Priority 4 -- Surpass C# Dev Kit (Weeks 21+)

Features where we go beyond what C# Dev Kit offers.

- [x] **P4.1: Call Hierarchy** — `call_hierarchy.rs`
  - [x] `textDocument/prepareCallHierarchy`
  - [x] Incoming calls
  - [x] Outgoing calls

- [x] **P4.2: Type Hierarchy** — `type_hierarchy.rs`
  - [x] `textDocument/prepareTypeHierarchy`
  - [x] Supertypes
  - [x] Subtypes

- [ ] **P4.3: Decompiled Source Navigation**
  - [ ] Navigate to decompiled source via ICSharpCode.Decompiler
  - [ ] Navigate to metadata-as-source
  - [ ] Source generator output navigation

- [ ] **P4.4: Advanced F# Features**
  - [ ] Signature file generation (.fsi)
  - [ ] FSI integration (send selection to F# Interactive)
  - [ ] File ordering awareness and reorder suggestions
  - [ ] FSharpLint integration
  - [ ] Fantomas formatting with preview
  - [ ] Pipeline operator type hints
  - [ ] Union case/record stub generation

- [ ] **P4.5: Cross-Language Features**
  - [ ] C# to F# go-to-definition
  - [ ] F# to C# go-to-definition
  - [ ] Cross-language find references

- [ ] **P4.6: Advanced Refactorings**
  - [ ] Change signature
  - [ ] Pull members up / push members down
  - [ ] Extract superclass / interface
  - [ ] Convert to LINQ / from LINQ
  - [ ] Safe delete
  - [ ] Convert class to record
  - [ ] Postfix completion templates

---

## Summary

| Priority | Feature Count | Weeks | Impact |
|----------|--------------|-------|--------|
| P1 - Critical | 6 tracks — **4 DONE**, 1 partial, 1 missing | 1-6 | Code actions, semantic tokens, inlay hints, formatting shipped; rename still missing |
| P2 - Essential | 4 tracks, ~35 items | 7-14 | Makes SharpLsp viable for daily use |
| P3 - Quality of Life | 5 tracks — **2 DONE**, 3 remaining | 15-20 | Workspace symbols + code lens shipped |
| P4 - Surpass | 6 tracks — **2 DONE**, 4 remaining | 21+ | Call hierarchy + type hierarchy shipped |

**Remaining gaps: ~40 items across P1-P4.**

The biggest remaining gaps are **rename** (P0 parity blocker), **debugging** (P2.1), and **test explorer** (P2.2). P2 remains the next broad feature area, but rename is the critical refactoring gap inside P1.

### What SharpLsp Already Does Better

Even today, SharpLsp goes beyond C# Dev Kit on:
1. **F# support** -- Dev Kit has literally zero
2. **Solution Explorer depth** -- members, namespaces, sort modes
3. **Profiler** -- full EventPipe/counter/heap integration
4. **Dependency management** -- remove packages/refs from context menu
5. **Call hierarchy + type hierarchy** -- Dev Kit has neither
6. **Open source** -- no license, no sign-in, no vendor lock-in
7. **Editor-agnostic** -- works in Zed and Rider too, not just VS Code
