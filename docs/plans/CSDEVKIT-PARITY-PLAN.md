# C# Dev Kit Parity Plan

Gap analysis and implementation roadmap to reach feature parity with C# Dev Kit, then surpass it.

## Gap Analysis: Forge vs C# Dev Kit

### Legend
- **DONE** = Forge has this fully working
- **PARTIAL** = Forge has some support but incomplete
- **MISSING** = Forge doesn't have this at all
- **SUPERIOR** = Forge already exceeds C# Dev Kit here

---

### Solution Explorer / Project Management

| Feature | C# Dev Kit | Forge | Status |
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
| Remove NuGet package | No (read-only) | Yes | **SUPERIOR** |
| Remove project reference | No (read-only) | Yes | **SUPERIOR** |
| Namespace merging in explorer | No | Yes | **SUPERIOR** |
| Member-level symbols in explorer | No | Yes | **SUPERIOR** |
| Sort modes (natural/alpha/accessibility) | No | Yes | **SUPERIOR** |
| F# project support | No | Yes | **SUPERIOR** |

### Code Intelligence

| Feature | C# Dev Kit | Forge | Status |
|---------|-----------|-------|--------|
| Auto-completion | Yes | Yes | **DONE** |
| Completion resolve | Yes | Yes | **DONE** |
| Import suggestions in completion | Yes | No | **MISSING** |
| Snippet completion | Yes | No | **MISSING** |
| Hover / Quick Info | Yes | Yes | **DONE** |
| Signature help | Yes | Yes | **DONE** |
| Inlay hints (parameter names) | Yes | No | **MISSING** |
| Inlay hints (type inference) | Yes | No | **MISSING** |
| Semantic highlighting | Yes | No | **MISSING** |
| Code snippets | Yes | No | **MISSING** |
| Background code analysis | Yes (configurable) | Yes | **DONE** |

### Code Navigation

| Feature | C# Dev Kit | Forge | Status |
|---------|-----------|-------|--------|
| Go to definition | Yes | Yes | **DONE** |
| Go to declaration | Yes | Yes | **DONE** |
| Go to type definition | Yes | Yes | **DONE** |
| Go to implementation | Yes | Yes | **DONE** |
| Find all references | Yes | Yes | **DONE** |
| Document highlights | Yes | Yes | **DONE** |
| Peek Definition (inline) | Yes | Yes (editor feature) | **DONE** |
| Workspace symbol search | Yes | Partial (custom) | **PARTIAL** |
| Breadcrumbs | Yes | No | **MISSING** |
| Call hierarchy | No | No | N/A |
| Type hierarchy | No | No | N/A |

### Code Actions & Refactorings

| Feature | C# Dev Kit | Forge | Status |
|---------|-----------|-------|--------|
| Add missing usings | Yes | No | **MISSING** |
| Organize usings | Yes | No | **MISSING** |
| Extract method | Yes | No | **MISSING** |
| Extract variable | Yes | No | **MISSING** |
| Inline variable/method | Yes | No | **MISSING** |
| Move type to file | Yes | No | **MISSING** |
| Generate constructor | Yes | No | **MISSING** |
| Generate interface impl | Yes | No | **MISSING** |
| Implement interface (explicit/implicit) | Yes | No | **MISSING** |
| Convert class to record | Yes | No | **MISSING** |
| Convert between string forms | Yes | No | **MISSING** |
| Encapsulate field | Yes | No | **MISSING** |
| Use var / explicit type | Yes | No | **MISSING** |
| Rename symbol | Yes | Yes | **DONE** |
| Sort members | No | Yes | **SUPERIOR** |
| All Roslyn quick fixes | Yes | No | **MISSING** |
| All Roslyn refactorings | Yes | No | **MISSING** |

### Formatting

| Feature | C# Dev Kit | Forge | Status |
|---------|-----------|-------|--------|
| Document formatting | Yes | No | **MISSING** |
| Range formatting | Yes | No | **MISSING** |
| On-type formatting | Yes | No | **MISSING** |
| Format on save | Yes | No | **MISSING** |
| EditorConfig support | Yes | Partial (diagnostics only) | **PARTIAL** |

### Diagnostics

| Feature | C# Dev Kit | Forge | Status |
|---------|-----------|-------|--------|
| Compiler diagnostics | Yes | Yes | **DONE** |
| Solution-wide analysis | Yes (configurable) | Yes (default enabled) | **DONE** |
| Roslyn analyzer diagnostics | Yes | Partial | **PARTIAL** |
| EditorConfig diagnostic config | Yes | Partial | **PARTIAL** |

### Test Explorer

| Feature | C# Dev Kit | Forge | Status |
|---------|-----------|-------|--------|
| Test discovery (xUnit, NUnit, MSTest) | Yes | No | **MISSING** |
| Run tests from editor | Yes | No | **MISSING** |
| Run tests from Test Explorer | Yes | No | **MISSING** |
| Debug tests | Yes | No | **MISSING** |
| Code coverage visualization | Yes | No | **MISSING** |
| Test result display | Yes | No | **MISSING** |
| bUnit support | Yes | No | **MISSING** |

### Debugging

| Feature | C# Dev Kit | Forge | Status |
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

All NuGet operations route through LSP custom requests (`forge/nuget/*`). The extension is a thin UI shell only.

| Feature | C# Dev Kit | Forge | Status |
|---------|-----------|-------|--------|
| Search & add packages | Yes | Partial (UI exists, needs LSP backend) | **IN PROGRESS** |
| Update packages | Yes | Partial (UI exists, needs LSP backend) | **IN PROGRESS** |
| Remove packages | Yes | Partial (UI exists, needs LSP backend) | **IN PROGRESS** |
| NuGet browser webview | No | Yes (needs design fixes) | **IN PROGRESS** |
| Auto-restore on load/build | Yes | No | **MISSING** |
| Prerelease toggle | Yes | No | **MISSING** |

### Project Scaffolding

| Feature | C# Dev Kit | Forge | Status |
|---------|-----------|-------|--------|
| New Project from template | Yes | No | **MISSING** |
| New File from template (class, interface, etc.) | Yes | No | **MISSING** |

### Features Where Forge is Already Superior

| Feature | Notes |
|---------|-------|
| F# as first-class citizen | C# Dev Kit has zero F# support |
| Solution Explorer depth | Forge shows namespaces, types, members; Dev Kit shows only files |
| Remove NuGet/project refs | Dev Kit tree is read-only |
| Sort members command | Not available in Dev Kit |
| .NET Profiler integration | Full EventPipe, counters, heap analysis -- Dev Kit has nothing |
| Copy qualified name | Context menu feature Dev Kit lacks |
| Open source, no license | Dev Kit requires VS subscription for organizations |
| Editor-agnostic | Dev Kit is VS Code only |

---

## Implementation Plan

### Priority 1 -- Critical Parity (Weeks 1-6)

These are the features users hit within the first 5 minutes. Without them, Forge feels broken.

- [ ] **P1.1: Code Actions & Quick Fixes**
  - [ ] Wire up Roslyn `CodeFixProvider` pipeline through sidecar IPC
  - [ ] Wire up Roslyn `CodeRefactoringProvider` pipeline through sidecar IPC
  - [ ] Implement `textDocument/codeAction` handler in Rust host
  - [ ] Implement `codeAction/resolve` for deferred workspace edits
  - [ ] Add missing usings / organize usings (single most-used code action)
  - [ ] Generate constructor, implement interface, generate overrides
  - [ ] Extract method, extract variable, inline variable
  - [ ] All remaining Roslyn built-in code fixes (expose full set)
  - [ ] All remaining Roslyn built-in refactorings (expose full set)
  - [ ] F# code fixes via FCS

- [ ] **P1.2: Formatting**
  - [ ] Implement `textDocument/formatting` via Roslyn Formatter (C#)
  - [ ] Implement `textDocument/formatting` via Fantomas (F#)
  - [ ] Implement `textDocument/rangeFormatting`
  - [ ] Implement `textDocument/onTypeFormatting` (semicolon, closing brace, newline)
  - [ ] EditorConfig full integration for formatting rules
  - [ ] Wire up format-on-save in VS Code extension settings

- [ ] **P1.3: Semantic Highlighting**
  - [ ] Implement `textDocument/semanticTokens/full` via Roslyn classifier (C#)
  - [ ] Implement `textDocument/semanticTokens/full` via FCS (F#)
  - [ ] Implement `textDocument/semanticTokens/range` for visible range optimization
  - [ ] Implement `textDocument/semanticTokens/full/delta` for incremental updates
  - [ ] Register token types and modifiers in server capabilities

- [ ] **P1.4: Inlay Hints**
  - [ ] Implement `textDocument/inlayHint` handler
  - [ ] Parameter name hints (C# + F#)
  - [ ] Type inference hints for `var` and lambdas (C#)
  - [ ] Type inference hints for let bindings (F#)
  - [ ] Pipeline type hints (F#)
  - [ ] Add VS Code settings to toggle each hint category

- [ ] **P1.5: Import Suggestions in Completion**
  - [ ] Enable Roslyn import completion provider
  - [ ] Auto-add using directive on completion commit
  - [ ] Show unimported type completions with (import) label

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

- [ ] **P2.4: NuGet Package Management** — see [NUGET-BROWSER-PLAN.md](NUGET-BROWSER-PLAN.md)
  - [ ] Implement `forge/nuget/search` LSP handler (Rust host)
  - [ ] Implement `forge/nuget/versions` LSP handler (Rust host)
  - [ ] Implement `forge/nuget/installed` LSP handler (Rust host)
  - [ ] Implement `forge/nuget/install` LSP handler (Rust host, + sidecar reload)
  - [ ] Implement `forge/nuget/uninstall` LSP handler (Rust host, + sidecar reload)
  - [ ] Refactor extension NuGet browser to use LSP requests (remove direct CLI/HTTP)
  - [ ] Fix NuGet browser UI to match design spec (Material icons, no emoji, no duplicate settings)
  - [ ] Add Dependencies section to details panel
  - [ ] Add automated VSIX tests for NuGet browser
  - [ ] Add E2E Rust tests for all forge/nuget/* handlers
  - [ ] Prerelease version toggle
  - [ ] NuGet restore command
  - [ ] Auto-restore on project load

### Priority 3 -- Quality of Life (Weeks 15-20)

Features that make the daily experience smooth.

- [ ] **P3.1: Project Scaffolding**
  - [ ] "Forge: New Project" command using `dotnet new` templates
  - [ ] Template selection quick pick (console, web, classlib, test, etc.)
  - [ ] "Forge: New File" command (class, interface, enum, struct, record)
  - [ ] Auto-add file to project
  - [ ] "Forge: Add Project to Solution" command

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

- [ ] **P3.4: Workspace Symbol Search**
  - [ ] Implement standard `workspace/symbol` LSP method
  - [ ] Fuzzy matching across solution
  - [ ] Symbol kind filtering

- [ ] **P3.5: Code Lens**
  - [ ] Reference count lens above types and members
  - [ ] Implementation count lens above interfaces/abstract classes
  - [ ] Test status lens (pass/fail indicator above test methods)

### Priority 4 -- Surpass C# Dev Kit (Weeks 21+)

Features where we go beyond what C# Dev Kit offers.

- [ ] **P4.1: Call Hierarchy**
  - [ ] `textDocument/prepareCallHierarchy`
  - [ ] Incoming calls
  - [ ] Outgoing calls

- [ ] **P4.2: Type Hierarchy**
  - [ ] `textDocument/prepareTypeHierarchy`
  - [ ] Supertypes
  - [ ] Subtypes

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
| P1 - Critical | 5 tracks, ~25 items | 1-6 | Stops users from bouncing immediately |
| P2 - Essential | 4 tracks, ~35 items | 7-14 | Makes Forge viable for daily use |
| P3 - Quality of Life | 5 tracks, ~15 items | 15-20 | Polished experience, closes remaining gaps |
| P4 - Surpass | 6 tracks, ~20 items | 21+ | Forge becomes objectively better than Dev Kit |

**Total parity features missing: ~75 items across all priorities.**

The biggest gaps are **code actions/refactorings** (P1.1), **debugging** (P2.1), and **test explorer** (P2.2). These three alone account for the majority of the perceived gap. Closing P1 + P2 gets Forge to ~90% parity. P3 closes the remaining gaps. P4 is where we win.

### What Forge Already Wins On

Even today, Forge beats C# Dev Kit on:
1. **F# support** -- Dev Kit has literally zero
2. **Solution Explorer depth** -- members, namespaces, sort modes
3. **Profiler** -- full EventPipe/counter/heap integration
4. **Dependency management** -- remove packages/refs from context menu
5. **Open source** -- no license, no sign-in, no vendor lock-in
6. **Editor-agnostic** -- works in Neovim, Helix, Zed, not just VS Code
