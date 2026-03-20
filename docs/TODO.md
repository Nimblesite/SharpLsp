# Forge TODO List

## Phase 1: Protocol Skeleton & Syntax Features (Months 1–3)

### Rust LSP Host Setup
- [x] Implement LSP 3.17 lifecycle (`initialize`, `initialized`, `shutdown`, `exit`)
- [x] Full document synchronization (`open`, `change`, `close`, `save`) with Virtual File System (VFS)
- [x] Request routing framework (classify incoming LSP requests by category)

### Tree-sitter Integration
- [x] Integrate tree-sitter runtime (v0.24.x)
- [x] C# grammar integration (tree-sitter-c-sharp v0.23.1)
- [ ] F# grammar integration (ionide/tree-sitter-fsharp)
- [x] Document symbols (`textDocument/documentSymbol`) from tree-sitter
- [x] Folding ranges (`textDocument/foldingRange`) from tree-sitter
- [x] Selection ranges (`textDocument/selectionRange`) from tree-sitter
- [x] Linked editing ranges (`textDocument/linkedEditingRange`) from tree-sitter
- [ ] Basic syntax highlighting via tree-sitter queries

### VS Code Extension
- [x] VS Code extension scaffold that spawns the Rust binary via stdio
- [x] Extension packaging and marketplace-ready structure

### Infrastructure
- [x] CI/CD pipeline with cross-platform builds (Linux, macOS, Windows)
- [~] Logging infrastructure via `tracing` crate with OpenTelemetry export (tracing done, OTel pending)
- [x] Configuration system via `forge.toml`
- [ ] Global tool installation support (`dotnet tool`)

---

## Phase 2: Sidecar Integration & Core Semantics (Months 4–8)

### C# Sidecar
- [ ] .NET sidecar process hosting Roslyn (Microsoft.CodeAnalysis v5.3.0+)
- [ ] MSBuildWorkspace integration for project/solution loading
- [ ] Design-time build evaluation
- [ ] SDK-style project support

### F# Sidecar
- [ ] .NET sidecar process hosting FSharp.Compiler.Service (v43.12+)
- [ ] Ionide.ProjInfo integration for project cracking
- [ ] F# project loading and evaluation

### IPC Protocol
- [ ] MessagePack serialization over named pipes / Unix domain sockets
- [ ] 4-byte length-prefix framing
- [ ] Request/response multiplexing with request IDs
- [ ] Cancellation support (matching `$/cancelRequest` semantics)
- [ ] Health monitoring (heartbeat pings every 5s, 2s timeout)
- [ ] Sidecar crash recovery with exponential backoff
- [ ] Sidecar lazy startup with ReadyToRun (R2R) compilation

### Code Intelligence (C# + F#)
- [ ] Auto-completion (`textDocument/completion`) — Roslyn `CompletionService` / FCS `GetDeclarationListInfo`
- [ ] Completion resolve (`completionItem/resolve`)
- [ ] Completion with import suggestions
- [ ] Snippet completion
- [ ] Hover / Quick Info (`textDocument/hover`) with XML doc rendering
- [ ] Signature help (`textDocument/signatureHelp`)

### Navigation (C# + F#)
- [ ] Go to definition (`textDocument/definition`)
- [ ] Go to declaration (`textDocument/declaration`)
- [ ] Go to type definition (`textDocument/typeDefinition`)
- [ ] Go to implementation (`textDocument/implementation`)
- [ ] Find all references (`textDocument/references`)
- [ ] Document highlights (`textDocument/documentHighlight`)
- [ ] Workspace symbol search (`workspace/symbol`)

### Diagnostics (C# + F#)
- [ ] Compiler diagnostics — real-time error squiggles (`textDocument/publishDiagnostics`)
- [ ] Roslyn analyzer diagnostics
- [ ] Unused using/open detection
- [ ] Full semantic tokens (`textDocument/semanticTokens/full`)
- [ ] Range semantic tokens (`textDocument/semanticTokens/range`)

### Rename & Caching
- [ ] Rename symbol (`textDocument/rename`) for both languages
- [ ] `salsa` database for incremental caching of semantic results
- [ ] Request coalescing and cancellation (150ms debounce window)

### Workspace
- [ ] Solution/project loading (`forge/openSolution`)
- [ ] File watching & auto-reload (`workspace/didChangeWatchedFiles`) via `notify` crate
- [ ] Unified C# + F# in one LSP server

---

## Phase 3: Code Actions, Refactoring & Formatting (Months 9–14)

### Code Fixes & Refactorings — C#
- [ ] Expose all Roslyn built-in `CodeFixProvider`s via LSP code actions
- [ ] Expose all Roslyn built-in `CodeRefactoringProvider`s via LSP code actions
- [ ] Extract method (`ExtractMethodCodeRefactoring`)
- [ ] Extract variable / constant / field (`IntroduceVariableCodeRefactoring`)
- [ ] Extract interface (`ExtractInterfaceRefactoring`)
- [ ] Inline variable / method (`InlineMethodRefactoring`)
- [ ] Move type to file (`MoveTypeRefactoring`)
- [ ] Generate constructor
- [ ] Generate equals / GetHashCode
- [ ] Generate interface implementation
- [ ] Generate overrides
- [ ] Generate property from field
- [ ] Add using directive (`AddImport` CodeFix)
- [ ] Organize usings
- [ ] Rename file to match type
- [ ] Surround with (try/catch, if, using, etc.)
- [ ] Convert between expression forms (string interpolation, var/explicit, method group/lambda, invert if)

### Code Fixes & Refactorings — F#
- [ ] FSAC code fixes and refactorings
- [ ] Generate match cases from discriminated union
- [ ] Generate record field stubs
- [ ] Open statement management (auto-open + organize)
- [ ] Union case generation
- [ ] Record stub generation
- [ ] Computation expression completions
- [ ] Pipeline type hints (inlay hints)

### Formatting
- [ ] Document formatting — Roslyn `Formatter` (C#) + Fantomas (F#)
- [ ] Range formatting
- [ ] On-type formatting
- [ ] Format on save
- [ ] `.editorconfig` full support for both languages

### Visual Features
- [ ] Inlay hints — type inference (C# + F#)
- [ ] Inlay hints — parameter names (C# + F#)
- [ ] Inlay hints — lambda return types (C#)
- [ ] Delta semantic tokens (`textDocument/semanticTokens/full/delta`)

### Advanced Navigation
- [ ] Call hierarchy — incoming (`textDocument/prepareCallHierarchy`)
- [ ] Call hierarchy — outgoing
- [ ] Type hierarchy — supertypes (`textDocument/prepareTypeHierarchy`)
- [ ] Type hierarchy — subtypes
- [ ] Navigate to decompiled source (ICSharpCode.Decompiler)
- [ ] Navigate to metadata as source
- [ ] Breadcrumb / scope bar
- [ ] Go to base member
- [ ] Find usages (advanced, grouped)

### Code Lens
- [ ] Reference count lens
- [ ] Implementation count lens

### Workspace
- [ ] Legacy .csproj/.fsproj support
- [ ] Multi-targeting support
- [ ] Central Package Management support
- [ ] Nullable reference analysis
- [ ] Code style enforcement (.editorconfig analyzers + FSharpLint)

---

## Phase 4: Advanced Features & Ecosystem (Months 15–20)

### Solution-Wide Analysis
- [ ] Solution-wide error analysis (SWEA equivalent)
- [ ] Third-party NuGet analyzer support
- [ ] FSharp.Analyzers.SDK support
- [ ] Code metrics (cyclomatic complexity)
- [ ] Value tracking / data flow analysis

### Testing
- [ ] Test discovery — xUnit, NUnit, MSTest
- [ ] Test discovery — Expecto, FsCheck (F#)
- [ ] Run individual test (`dotnet test --filter`)
- [ ] Run test class / namespace
- [ ] Debug individual test (DAP + test runner)
- [ ] Test result inline display (code lens)

### Debugging (DAP Integration)
- [ ] Launch/attach .NET process via netcoredbg
- [ ] Breakpoints (line, conditional, logpoint)
- [ ] Step in/out/over
- [ ] Variable inspection
- [ ] Call stack navigation
- [ ] Watch expressions
- [ ] Exception breakpoints
- [ ] Hot reload via `dotnet watch`

### Workspace & Project Management
- [ ] Project dependency visualization
- [ ] NuGet package search & install
- [ ] NuGet package update suggestions
- [ ] Add/remove project reference

### F#-Specific
- [ ] Signature file generation (.fsi)
- [ ] F# Interactive (FSI) integration
- [ ] File ordering awareness & reorder suggestions
- [ ] Type provider navigation
- [ ] FSharpLint integration
- [ ] Convert pipe to/from nested function calls

### Additional Refactorings
- [ ] Change signature
- [ ] Introduce parameter
- [ ] Move type to namespace
- [ ] Safe delete
- [ ] Pull members up / push members down
- [ ] Extract superclass
- [ ] Convert to LINQ / from LINQ
- [ ] Convert class to record (C#)
- [ ] Convert anonymous type to class/record
- [ ] Cross-language go-to-definition (C# ↔ F#)
- [ ] Cross-language find references (C# ↔ F#)
- [ ] Navigate to source generator output
- [ ] Go to related files
- [ ] Structural navigation (next/prev member)
- [ ] Format on paste
- [ ] Code cleanup profiles
- [ ] Postfix completion templates
- [ ] Regex syntax highlighting in strings

### Multi-Editor Verification
- [ ] Neovim
- [ ] Helix
- [ ] Zed
- [ ] Emacs
- [ ] Sublime Text

### Performance
- [ ] Performance optimization pass (memory budgets, cache eviction, lazy loading)
- [ ] Cold start < 3 seconds
- [ ] Warm completion latency < 100ms p50, < 200ms p95
- [ ] Hover latency < 150ms p50
- [ ] Find references (1000-file solution) < 2 seconds
- [ ] Memory < 2GB Rust + < 3GB sidecar (600K LOC solution)
